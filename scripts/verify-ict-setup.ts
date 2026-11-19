/**
 * ICT Setup 状态机自检（纯逻辑，无需 UI / 浏览器）
 *
 * 运行：
 *   node_modules/.bin/esbuild scripts/verify-ict-setup.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=/tmp/ict-setup-check.mjs
 *   node /tmp/ict-setup-check.mjs
 */
import { buildIctSetups } from "../src/lib/chart/indicators/ictSetup";
import type { Candle, SwingPoint } from "../src/types/chart";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log("  ✅", msg);
  } else {
    failed += 1;
    console.log("  ❌", msg);
  }
}

const near = (a: number | undefined, b: number, eps = 1e-6) =>
  a !== undefined && Math.abs(a - b) <= eps;

function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: i * 600, open: o, high: h, low: l, close: c, volume: 1 };
}
function sp(i: number, type: "high" | "low", price: number): SwingPoint {
  return { type, price, index: i, time: i * 600 };
}

/** 找某一方向的 setup */
function pick(setups: ReturnType<typeof buildIctSetups>, direction: "bullish" | "bearish") {
  return setups.find((s) => s.direction === direction);
}

// ---------------------------------------------------------------------------
console.log("\n[1] 数据不足 → 返回空数组");
{
  const few: Candle[] = [];
  for (let i = 0; i < 10; i++) few.push(bar(i, 100, 101, 99, 100));
  const setups = buildIctSetups(few, [sp(1, "high", 101), sp(3, "low", 99)]);
  assert(setups.length === 0, `K 线不足时 setups = ${setups.length}（期望 0）`);

  const enough = buildIctSetups(
    Array.from({ length: 40 }, (_, i) => bar(i, 100, 101, 99, 100)),
    [sp(1, "high", 101)]
  );
  assert(enough.length === 0, `swing 不足时 setups = ${enough.length}（期望 0）`);
}

// ---------------------------------------------------------------------------
console.log("\n[2] 观察态：池还没被触及 → watching");
{
  const candles: Candle[] = [];
  for (let i = 0; i < 40; i++) candles.push(bar(i, 106, 108, 105, 107));
  candles.push(bar(40, 106, 106.5, 100, 104)); // 等低 100
  for (let i = 41; i < 50; i++) candles.push(bar(i, 106, 109, 105, 108));
  candles.push(bar(50, 108, 111, 107, 110)); // 前高 111
  for (let i = 51; i < 60; i++) candles.push(bar(i, 108, 110, 106, 107));

  const setups = buildIctSetups(candles, [sp(40, "low", 100), sp(50, "high", 111)]);
  const bull = pick(setups, "bullish");
  assert(!!bull, "生成了多头 setup");
  assert(bull?.state === "watching", `状态 = ${bull?.state}（期望 watching）`);
  assert(bull?.pool.level === 100, `池位 = ${bull?.pool.level}（期望 100）`);
  assert(/等待价格扫掉/.test(bull?.reason ?? ""), `提示 = ${bull?.reason}`);
}

// ---------------------------------------------------------------------------
console.log("\n[3] 触及未收回（确认窗口未走完）→ touched");
{
  const candles: Candle[] = [];
  for (let i = 0; i < 10; i++) candles.push(bar(i, 100, 101, 100, 100.5));
  candles.push(bar(10, 100, 101, 100, 101)); // 等低 100 #1
  for (let i = 11; i < 15; i++) candles.push(bar(i, 101, 105, 100.5, 104));
  candles.push(bar(15, 104, 105, 104, 104.5)); // 前高 105
  for (let i = 16; i < 20; i++) candles.push(bar(i, 104, 104.5, 101, 102));
  candles.push(bar(20, 102, 103, 100, 101.5)); // 等低 100 #2
  for (let i = 21; i < 28; i++) candles.push(bar(i, 101.2, 101.6, 100.3, 101.4));
  candles.push(bar(28, 101, 101.2, 99, 99.5)); // 触及 100 并收在下方
  candles.push(bar(29, 99.5, 100, 99.2, 99.8));

  const setups = buildIctSetups(candles, [
    sp(10, "low", 100),
    sp(15, "high", 105),
    sp(20, "low", 100),
  ]);
  const bull = pick(setups, "bullish");
  assert(!!bull, "生成了多头 setup");
  assert(bull?.state === "touched", `状态 = ${bull?.state}（期望 touched）`);
  assert(bull?.pool.pending === true, `池 pending = ${bull?.pool.pending}（期望 true）`);
  assert(bull?.pool.swept === false, "未确认扫荡（swept = false）");
  assert(/已触及/.test(bull?.reason ?? ""), `提示 = ${bull?.reason}`);
}

// ---------------------------------------------------------------------------
console.log("\n[4] 真突破（窗口走完仍未收回）→ invalid");
{
  const candles: Candle[] = [];
  for (let i = 0; i < 10; i++) candles.push(bar(i, 100, 101, 100, 100.5));
  candles.push(bar(10, 100, 101, 100, 101));
  for (let i = 11; i < 15; i++) candles.push(bar(i, 101, 105, 100.5, 104));
  candles.push(bar(15, 104, 105, 104, 104.5));
  for (let i = 16; i < 20; i++) candles.push(bar(i, 104, 104.5, 101, 102));
  candles.push(bar(20, 102, 103, 100, 101.5));
  for (let i = 21; i < 25; i++) candles.push(bar(i, 101.2, 101.6, 100.3, 101.4));
  // 连续 4 根收在 100 下方 → 真突破
  candles.push(bar(25, 101, 101.2, 99, 99.4));
  candles.push(bar(26, 99.4, 99.8, 98.8, 99));
  candles.push(bar(27, 99, 99.4, 98.5, 98.8));
  candles.push(bar(28, 98.8, 99.2, 98.2, 98.6));
  // 价格回到池上方
  candles.push(bar(29, 98.6, 100.8, 98.4, 100.5));

  const setups = buildIctSetups(candles, [
    sp(10, "low", 100),
    sp(15, "high", 105),
    sp(20, "low", 100),
  ]);
  const bull = pick(setups, "bullish");
  assert(!!bull, "生成了多头 setup");
  assert(bull?.state === "invalid", `状态 = ${bull?.state}（期望 invalid）`);
  assert(bull?.pool.broken === true, `池 broken = ${bull?.pool.broken}（期望 true）`);
  assert(/真突破/.test(bull?.reason ?? ""), `提示 = ${bull?.reason}`);
}

// ---------------------------------------------------------------------------
console.log("\n[5] 多头完整链条：等低池 → 扫荡 → 位移 → 回踩 POI → ready");
{
  const candles: Candle[] = [];
  // 0..9 窄幅震荡
  for (let i = 0; i < 10; i++) candles.push(bar(i, 100, 101, 100, 100.5));
  candles.push(bar(10, 100, 101, 100, 101)); // 等低 100 #1
  candles.push(bar(11, 101, 104, 100.5, 103.5));
  candles.push(bar(12, 103.5, 106, 103, 105.5));
  candles.push(bar(13, 105.5, 109, 105, 108.5));
  candles.push(bar(14, 108.5, 111, 108, 110.5));
  candles.push(bar(15, 110.5, 112, 110, 111)); // 前高 112（结构位）
  candles.push(bar(16, 111, 111.5, 108, 108.5));
  candles.push(bar(17, 108.5, 109, 105, 105.5));
  candles.push(bar(18, 105.5, 106, 103, 103.5));
  candles.push(bar(19, 103.5, 104, 101, 101.5));
  candles.push(bar(20, 101.5, 102, 100, 101)); // 等低 100 #2
  candles.push(bar(21, 101, 101.5, 99, 101)); // 扫荡：插针到 99，收回 100 上方
  candles.push(bar(22, 101, 114, 100.5, 113.5)); // 位移：收盘 113.5 > 112
  candles.push(bar(23, 113.5, 114, 101, 102.5));
  candles.push(bar(24, 102.5, 103, 100.8, 101.5));
  candles.push(bar(25, 101.5, 102, 100.2, 101));
  candles.push(bar(26, 101, 101.5, 100.1, 100.8));
  candles.push(bar(27, 100.8, 101, 100, 100.5));
  candles.push(bar(28, 100.5, 101.2, 100.2, 101));
  candles.push(bar(29, 101, 101.5, 100.3, 100.9)); // 回踩进 POI → ready

  const setups = buildIctSetups(candles, [
    sp(5, "high", 101),
    sp(10, "low", 100),
    sp(15, "high", 112),
    sp(20, "low", 100),
  ]);
  const bull = pick(setups, "bullish");
  assert(!!bull, "生成了多头 setup");
  assert(bull?.state === "ready", `状态 = ${bull?.state}（期望 ready）`);
  assert(bull?.pool.level === 100, `池位 = ${bull?.pool.level}（期望 100）`);
  assert(bull?.pool.isEqual === true, `池 strength = ${bull?.pool.strength}（期望等低池）`);
  assert(bull?.sweep?.index === 21, `扫荡 K = ${bull?.sweep?.index}（期望 21）`);
  assert(near(bull?.sweep?.extreme, 99), `扫荡极值 = ${bull?.sweep?.extreme}（期望 99）`);
  assert(bull?.displacement?.index === 22, `位移 K = ${bull?.displacement?.index}（期望 22）`);
  assert(near(bull?.displacement?.level, 112), `位移结构位 = ${bull?.displacement?.level}（期望 112）`);
  assert(bull?.poi?.type === "ob", `POI 类型 = ${bull?.poi?.type}（期望 ob）`);
  assert(near(bull?.poi?.low, 99) && near(bull?.poi?.high, 101.5), `POI = ${bull?.poi?.low}~${bull?.poi?.high}（期望 99~101.5）`);
  assert(near(bull?.entry?.price, 100.25), `入场 = ${bull?.entry?.price}（期望 100.25 = POI 中值）`);
  assert(near(bull?.stopLoss, 98.901), `止损 = ${bull?.stopLoss}（期望 98.901 = 扫荡极值 99 - 0.1%）`);
  assert((bull?.stopLoss ?? 0) < (bull?.sweep?.extreme ?? 0), "止损在扫荡极值之外");
  const tp1 = bull?.targets?.[0]?.price;
  assert(tp1 !== undefined && tp1 > (bull?.entry?.price ?? 0), `目标 = ${tp1}（应高于入场）`);
  assert(bull?.targets?.[0]?.label === "2R", `目标标签 = ${bull?.targets?.[0]?.label}（期望 2R 兜底）`);
  assert(near(bull?.rr, 2, 1e-6), `R = ${bull?.rr}（期望 2）`);
}

// ---------------------------------------------------------------------------
console.log("\n[6] 目标 = 上方最近的未扫池（等高点）");
{
  const candles: Candle[] = [];
  candles.push(bar(0, 125, 130, 124, 129));
  candles.push(bar(1, 129, 130, 127, 128));
  candles.push(bar(2, 128, 130, 126, 129)); // 远端前高 130（之后再没碰过）
  candles.push(bar(3, 128, 129, 124, 125));
  candles.push(bar(4, 125, 126, 120, 121));
  candles.push(bar(5, 121, 122, 115, 116));
  candles.push(bar(6, 116, 117, 110, 111));
  candles.push(bar(7, 111, 112, 106, 107));
  candles.push(bar(8, 107, 108, 102, 103));
  candles.push(bar(9, 103, 104, 100.5, 101));
  candles.push(bar(10, 101, 101.5, 100, 101)); // 等低 100 #1
  candles.push(bar(11, 101, 102, 100.5, 101.5));
  candles.push(bar(12, 101.5, 103, 101, 102.5));
  candles.push(bar(13, 102.5, 104, 102, 103.5));
  candles.push(bar(14, 103.5, 105, 103, 104.5));
  candles.push(bar(15, 104.5, 105, 104, 104)); // 前高 105（结构位）
  candles.push(bar(16, 104, 104.5, 102, 102.5));
  candles.push(bar(17, 102.5, 103, 101, 101.5));
  candles.push(bar(18, 101.5, 102, 100.5, 101));
  candles.push(bar(19, 101, 101.5, 100.2, 100.6));
  candles.push(bar(20, 100.6, 101, 100, 100.5)); // 等低 100 #2
  candles.push(bar(21, 100.5, 101, 99, 100.8)); // 扫荡
  candles.push(bar(22, 100.8, 107, 100.2, 106.5)); // 位移：收盘 > 105
  candles.push(bar(23, 106.5, 107, 102, 103)); // 收回 105 下方（105 池被扫）
  candles.push(bar(24, 103, 103.5, 101.5, 102));
  candles.push(bar(25, 102, 102.5, 101, 101.5));
  candles.push(bar(26, 101.5, 102, 100.5, 101));
  candles.push(bar(27, 101, 101.5, 100.2, 100.7));
  candles.push(bar(28, 100.7, 101, 100.3, 100.6));
  candles.push(bar(29, 100.6, 101, 100.4, 100.9)); // 回踩进 POI → ready

  const setups = buildIctSetups(candles, [
    sp(2, "high", 130),
    sp(10, "low", 100),
    sp(15, "high", 105),
    sp(20, "low", 100),
  ]);
  const bull = pick(setups, "bullish");
  assert(bull?.state === "ready", `状态 = ${bull?.state}（期望 ready）`);
  assert(near(bull?.entry?.price, 100), `入场 = ${bull?.entry?.price}（期望 100）`);
  assert(near(bull?.targets?.[0]?.price, 130), `目标 = ${bull?.targets?.[0]?.price}（期望 130 = 上方未扫前高）`);
  assert(bull?.targets?.[0]?.label === "上方前高", `目标标签 = ${bull?.targets?.[0]?.label}（期望 上方前高）`);
  const tp = bull?.targets?.[0]?.price ?? 0;
  assert(tp > (bull?.entry?.price ?? 0), "目标高于入场");
  assert((bull?.stopLoss ?? 0) < (bull?.entry?.price ?? 0), "止损低于入场");
}

// ---------------------------------------------------------------------------
console.log("\n[7] 空头对称：等高池 → 扫荡 → 位移 → 回踩 POI → ready");
{
  const candles: Candle[] = [];
  for (let i = 0; i < 5; i++) candles.push(bar(i, 106, 109, 105, 108));
  candles.push(bar(5, 108, 109, 105, 106)); // 前低 105
  candles.push(bar(6, 106, 107, 105.5, 106.5));
  candles.push(bar(7, 106.5, 108, 106, 107.5));
  candles.push(bar(8, 107.5, 109, 107, 108.5));
  candles.push(bar(9, 108.5, 109.5, 108, 109));
  candles.push(bar(10, 109, 110, 108.5, 109.5)); // 等高 110 #1
  candles.push(bar(11, 109.5, 109.5, 106, 106.5));
  candles.push(bar(12, 106.5, 107, 104, 104.5));
  candles.push(bar(13, 104.5, 105, 102, 102.5));
  candles.push(bar(14, 102.5, 103, 99, 99.5));
  candles.push(bar(15, 99.5, 100, 95, 95.5)); // 前低 95（结构位）
  candles.push(bar(16, 95.5, 98, 95, 97.5));
  candles.push(bar(17, 97.5, 101, 97, 100.5));
  candles.push(bar(18, 100.5, 104, 100, 103.5));
  candles.push(bar(19, 103.5, 107, 103, 106.5));
  candles.push(bar(20, 106.5, 110, 106, 109.5)); // 等高 110 #2
  candles.push(bar(21, 109.5, 111, 109, 109.2)); // 扫荡：插针到 111，收回 110 下方
  candles.push(bar(22, 109.2, 109.5, 93, 93.5)); // 位移：收盘 93.5 < 95
  candles.push(bar(23, 93.5, 95, 93, 94.5));
  candles.push(bar(24, 94.5, 98, 94, 97.5));
  candles.push(bar(25, 97.5, 102, 97, 101.5));
  candles.push(bar(26, 101.5, 105, 101, 104.5));
  candles.push(bar(27, 104.5, 107, 104, 106.5));
  candles.push(bar(28, 106.5, 109.5, 106, 109));
  candles.push(bar(29, 109, 110.5, 108.8, 109.5)); // 回踩进 POI → ready

  const setups = buildIctSetups(candles, [
    sp(5, "low", 105),
    sp(10, "high", 110),
    sp(15, "low", 95),
    sp(20, "high", 110),
  ]);
  const bear = pick(setups, "bearish");
  assert(!!bear, "生成了空头 setup");
  assert(bear?.state === "ready", `状态 = ${bear?.state}（期望 ready）`);
  assert(bear?.pool.level === 110, `池位 = ${bear?.pool.level}（期望 110）`);
  assert(bear?.pool.isEqual === true, "等高池");
  assert(bear?.sweep?.index === 21, `扫荡 K = ${bear?.sweep?.index}（期望 21）`);
  assert(near(bear?.sweep?.extreme, 111), `扫荡极值 = ${bear?.sweep?.extreme}（期望 111）`);
  assert(bear?.displacement?.index === 22, `位移 K = ${bear?.displacement?.index}（期望 22）`);
  assert(near(bear?.displacement?.level, 95), `位移结构位 = ${bear?.displacement?.level}（期望 95）`);
  assert(near(bear?.entry?.price, 110), `入场 = ${bear?.entry?.price}（期望 110 = POI 中值）`);
  assert(near(bear?.stopLoss, 111.111), `止损 = ${bear?.stopLoss}（期望 111.111 = 扫荡极值 111 + 0.1%）`);
  assert((bear?.stopLoss ?? 0) > (bear?.sweep?.extreme ?? 0), "止损在扫荡极值之外");
  const tp1 = bear?.targets?.[0]?.price;
  assert(tp1 !== undefined && tp1 < (bear?.entry?.price ?? 0), `目标 = ${tp1}（应低于入场）`);
  assert((bear?.stopLoss ?? 0) > (bear?.entry?.price ?? 0), "空头止损高于入场");
}

console.log(failed === 0 ? "\n✅ ICT Setup 状态机自检全部通过\n" : `\n❌ 自检失败 ${failed} 项\n`);
if (failed > 0) process.exit(1);
