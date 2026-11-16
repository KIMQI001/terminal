/**
 * 回放撮合引擎自检（纯逻辑，无需 UI / 浏览器）
 *
 * 运行：
 *   node_modules/.bin/esbuild scripts/verify-replay-engine.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=/tmp/replay-engine-check.mjs
 *   node /tmp/replay-engine-check.mjs
 */
import { createInitialState, simulateBar, placeOrder, finalizeState } from "../src/lib/replay/engine";
import { pickReplayWindow } from "../src/lib/replay/snapshot";
import { buildScore } from "../src/lib/replay/scoring";
import type { Candle } from "../src/types/chart";
import type { ReplayConfig } from "../src/lib/replay/types";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log("  ✅", msg);
  } else {
    failed += 1;
    console.log("  ❌", msg);
  }
}

const cfg: ReplayConfig = {
  symbol: "TEST",
  timeframe: "15m",
  barCount: 10,
  initialCapital: 1000,
  quantity: 1,
  leverage: 1,
  maxPositions: 1,
  maxRiskPerTradePct: 2,
  maxStopLossPct: 5,
  maxMarginUsagePct: 50,
  maxDrawdownPct: 15,
  speed: 2,
};

function bar(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c, volume: 1 };
}

// ---------------------------------------------------------------------------
console.log("\n[1] pickReplayWindow：剔除未收盘的形成中 K");
{
  const now = 1_700_000_000;
  const candles = [
    bar(now - 5 * 900, 100, 101, 99, 100),
    bar(now - 4 * 900, 100, 102, 99, 101),
    bar(now - 3 * 900, 101, 103, 100, 102),
    bar(now - 2 * 900, 102, 104, 101, 103),
    bar(now - 60, 103, 105, 102, 104), // 形成中：time + 900 > now
  ];
  const w = pickReplayWindow(candles, "15m", 10, now);
  assert(w.closedCount === 1, `剔除了 ${w.closedCount} 根形成中的 K（期望 1）`);
  assert(w.bars.length === 4, `回放窗口 ${w.bars.length} 根（期望 4）`);
  assert(w.windowStartIndex === 0, `windowStartIndex = ${w.windowStartIndex}（期望 0）`);
}

// ---------------------------------------------------------------------------
console.log("\n[2] 市价单：最早在下一根 K 的 open 成交，当根不成交");
{
  const bars = [bar(1000, 100, 101, 99, 100), bar(2000, 101, 102, 100, 101)];
  let st = createInitialState(cfg);
  const res = placeOrder(st, { side: "buy", type: "market", quantity: 1 }, cfg, 0, bars[0].close);
  assert(res.ok, "市价买单创建成功");
  st = simulateBar(st, bars[0], 0, cfg);
  assert(st.positions.length === 0, "在第 0 根成交 = 错误（应最早在第 1 根）");
  st = simulateBar(st, bars[1], 1, cfg);
  assert(st.positions.length === 1, "在第 1 根成交");
  assert(st.positions[0].entryPrice === 101, `成交价 = ${st.positions[0].entryPrice}（期望 101 = 下一根 open）`);
  assert(st.fills.length === 1 && st.fills[0].bar === 1, "成交记录 bar = 1");
}

// ---------------------------------------------------------------------------
console.log("\n[3] 限价单：触及的那根成交，成交价 = 限价");
{
  const bars = [bar(1000, 100, 101, 99, 100), bar(2000, 100, 101, 98, 99)];
  let st = createInitialState(cfg);
  const res = placeOrder(st, { side: "buy", type: "limit", price: 99, quantity: 1 }, cfg, 0, bars[0].close);
  assert(res.ok, "限价买单创建成功");
  st = simulateBar(st, bars[0], 0, cfg);
  assert(st.positions.length === 0, "第 0 根未触及（low 99 不 < 99 之外的判定）不应成交");
  st = simulateBar(st, bars[1], 1, cfg);
  assert(st.positions.length === 1, "第 1 根 low=98 <= 99 → 成交");
  assert(st.positions[0].entryPrice === 99, `成交价 = ${st.positions[0].entryPrice}（期望 99 = 限价）`);
}

// ---------------------------------------------------------------------------
console.log("\n[4] 同一根 K 内 SL 与 TP 都触及 → SL 优先");
{
  const bars = [bar(1000, 100, 101, 99, 100), bar(2000, 100, 101, 99, 100), bar(3000, 100, 106, 94, 100)];
  let st = createInitialState(cfg);
  placeOrder(st, { side: "buy", type: "market", quantity: 1, stopLoss: 95, takeProfit: 105 }, cfg, 0, 100);
  st = simulateBar(st, bars[0], 0, cfg);
  st = simulateBar(st, bars[1], 1, cfg);
  assert(st.positions.length === 1, "持仓建立");
  st = simulateBar(st, bars[2], 2, cfg);
  assert(st.positions.length === 0, "已平仓");
  assert(st.trades.length === 1 && st.trades[0].exitReason === "sl", `exitReason = ${st.trades[0]?.exitReason}（期望 sl）`);
  assert(st.trades[0].exitPrice === 95, `成交价 = ${st.trades[0].exitPrice}（期望 95）`);
  assert(st.trades[0].pnl === -5, `pnl = ${st.trades[0].pnl}（期望 -5）`);
}

// ---------------------------------------------------------------------------
console.log("\n[5] 跳空开盘越过 SL → 按开盘价止损");
{
  const bars = [bar(1000, 100, 101, 99, 100), bar(2000, 100, 101, 99, 100), bar(3000, 90, 92, 88, 91)];
  let st = createInitialState(cfg);
  placeOrder(st, { side: "buy", type: "market", quantity: 1, stopLoss: 95 }, cfg, 0, 100);
  st = simulateBar(st, bars[0], 0, cfg);
  st = simulateBar(st, bars[1], 1, cfg);
  assert(st.positions.length === 1, `持仓建立，entry = ${st.positions[0]?.entryPrice}`);
  st = simulateBar(st, bars[2], 2, cfg);
  assert(st.trades.length === 1 && st.trades[0].exitReason === "sl", "跳空触发止损");
  assert(st.trades[0].exitPrice === 90, `成交价 = ${st.trades[0].exitPrice}（期望 90 = 开盘价）`);
}

// ---------------------------------------------------------------------------
console.log("\n[6] 跳空开盘越过 TP → 按 TP 价止盈（不给跳空溢价）");
{
  const bars = [bar(1000, 100, 101, 99, 100), bar(2000, 100, 101, 99, 100), bar(3000, 110, 112, 108, 111)];
  let st = createInitialState(cfg);
  placeOrder(st, { side: "buy", type: "market", quantity: 1, stopLoss: 95, takeProfit: 105 }, cfg, 0, 100);
  st = simulateBar(st, bars[0], 0, cfg);
  st = simulateBar(st, bars[1], 1, cfg);
  assert(st.positions.length === 1, `持仓建立，entry = ${st.positions[0]?.entryPrice}`);
  st = simulateBar(st, bars[2], 2, cfg);
  assert(st.trades.length === 1 && st.trades[0].exitReason === "tp", "跳空触发止盈");
  assert(st.trades[0].exitPrice === 105, `成交价 = ${st.trades[0].exitPrice}（期望 105 = TP 价）`);
}

// ---------------------------------------------------------------------------
console.log("\n[7] 账本快照：回看视图不影响账本");
{
  const bars = [bar(1000, 100, 101, 99, 100), bar(2000, 101, 102, 100, 101), bar(3000, 102, 103, 101, 102)];
  let st = createInitialState(cfg);
  placeOrder(st, { side: "buy", type: "market", quantity: 1 }, cfg, 0, 100);
  st = simulateBar(st, bars[0], 0, cfg);
  st = simulateBar(st, bars[1], 1, cfg);
  st = simulateBar(st, bars[2], 2, cfg);
  assert(Object.keys(st.snapshots).length === 3, `快照数 = ${Object.keys(st.snapshots).length}（期望 3）`);
  const snap1 = st.snapshots[1];
  assert(snap1 && snap1.positions.length === 1, "快照 1 记录了当时的持仓");
  assert(st.frontier === 2, `frontier = ${st.frontier}（期望 2）`);
}

// ---------------------------------------------------------------------------
console.log("\n[8] 结束回放：撤销挂单 + 剩余持仓强平");
{
  const bars = [bar(1000, 100, 101, 99, 100), bar(2000, 101, 102, 100, 101)];
  let st = createInitialState(cfg);
  placeOrder(st, { side: "buy", type: "limit", price: 50, quantity: 1 }, cfg, 0, 100);
  st = simulateBar(st, bars[0], 0, cfg);
  st = simulateBar(st, bars[1], 1, cfg);
  const fin = finalizeState(st, bars[1].close, 1, bars[1].time);
  assert(fin.orders.every((o) => o.status !== "pending"), "未成交挂单已撤销");
  assert(fin.trades.length === 0, "没有持仓 → 没有交易");
}

// ---------------------------------------------------------------------------
console.log("\n[9] 评分：无止损开仓 → 纪律分 ≤ 80 且含「未设置止损」明细");
{
  const bars = [bar(1000, 100, 101, 99, 100), bar(2000, 101, 102, 100, 101), bar(3000, 102, 103, 101, 102)];
  let st = createInitialState(cfg);
  placeOrder(st, { side: "buy", type: "market", quantity: 1 }, cfg, 0, 100);
  st = simulateBar(st, bars[0], 0, cfg);
  st = simulateBar(st, bars[1], 1, cfg);
  st = simulateBar(st, bars[2], 2, cfg);
  const fin = finalizeState(st, bars[2].close, 2, bars[2].time);
  const score = buildScore(fin.trades, fin.account, cfg, bars, fin.orders);
  const disc = score.sections.find((s) => s.key === "discipline")!;
  assert(disc.score <= 80, `纪律分 = ${disc.score}（期望 ≤ 80）`);
  assert(disc.items.some((i) => i.label === "未设置止损"), "明细含「未设置止损」");
  assert(score.total >= 0 && score.total <= 100, `总分 = ${score.total}`);
  console.log(`     总分 ${score.total}（${score.grade}）`, score.sections.map((s) => `${s.title} ${s.score}`).join(" / "));

  // 每条扣分的 tradeSeq 都能在 trades 里找到
  const seqs = new Set(fin.trades.map((t) => t.seq));
  const allItems = score.sections.flatMap((s) => s.items);
  const bad = allItems.filter((i) => i.tradeSeq != null && !seqs.has(i.tradeSeq));
  assert(bad.length === 0, `所有扣分项的 tradeSeq 都能追溯（异常 ${bad.length} 条）`);
}

// ---------------------------------------------------------------------------
console.log("\n[10] 限价单校验：必须低于现价（买）/ 高于现价（卖）");
{
  const st = createInitialState(cfg);
  const bad = placeOrder(st, { side: "buy", type: "limit", price: 105, quantity: 1 }, cfg, 0, 100);
  assert(!bad.ok && !!bad.error, `高于现价的限价买被拒绝：${bad.error}`);
  const bad2 = placeOrder(st, { side: "sell", type: "limit", price: 95, quantity: 1 }, cfg, 0, 100);
  assert(!bad2.ok && !!bad2.error, `低于现价的限价卖被拒绝：${bad2.error}`);
  const good = placeOrder(st, { side: "buy", type: "limit", price: 95, quantity: 1 }, cfg, 0, 100);
  assert(good.ok, "低于现价的限价买被接受");
}

console.log(failed === 0 ? "\n✅ 引擎自检全部通过\n" : `\n❌ 引擎自检失败 ${failed} 项\n`);
if (failed > 0) process.exit(1);
