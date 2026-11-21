/**
 * 市场结构自检（BOS / CHoCH，纯逻辑，无需 UI / 浏览器）
 *
 * 运行：
 *   node_modules/.bin/esbuild scripts/verify-ict-structure.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=/tmp/ict-structure-check.mjs
 *   node /tmp/ict-structure-check.mjs
 *
 * 说明：合成 K 线都遵守「pivot 需要右侧确认」的现实约束 ——
 * 摆动点 index + 2 才成立（相当于 pivot length = 3），
 * 所以价格必须先突破旧高点，才会形成更高的新高点（真实行情也是如此）。
 */
import { detectStructure } from "../src/lib/chart/indicators/structure";
import { classifyPivots } from "../src/lib/chart/indicators/pivotDetector";
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

function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: 1000 + i * 600, open: o, high: h, low: l, close: c, volume: 1 };
}

/**
 * 构造一个 swing 点（已带分类）
 *
 * @param confirmLag - 右侧确认滞后（bars），默认 2（= pivot length 3 - 1）
 */
function sp(
  i: number,
  type: "high" | "low",
  price: number,
  classification?: SwingPoint["classification"],
  firstOfType?: boolean,
  confirmLag: number = 2
): SwingPoint {
  return {
    type,
    price,
    index: i,
    time: 1000 + i * 600,
    classification,
    firstOfType,
    confirmIndex: i + confirmLag,
  };
}

/** 汇总两类信号，按时间排序，便于比较 */
function allSignals(r: { bos: Array<{ time: number; level: number; type: string }>; choch: Array<{ time: number; level: number; type: string }> }) {
  return [
    ...r.bos.map((s) => ({ kind: "bos" as const, ...s })),
    ...r.choch.map((s) => ({ kind: "choch" as const, ...s })),
  ].sort((a, b) => a.time - b.time || a.level - b.level);
}

// ---------------------------------------------------------------------------
console.log("\n[1] 数据不足 → 返回空");
{
  const few: Candle[] = Array.from({ length: 2 }, (_, i) => bar(i, 100, 101, 99, 100));
  const r = detectStructure(few, [sp(0, "high", 101), sp(1, "low", 99)]);
  assert(r.bos.length === 0 && r.choch.length === 0, "K 线不足时无信号");

  const candles: Candle[] = Array.from({ length: 40 }, (_, i) => bar(i, 100, 101, 99, 100));
  const r2 = detectStructure(candles, [sp(1, "high", 101)]);
  assert(r2.bos.length === 0 && r2.choch.length === 0, "swing 不足时无信号");
}

// ---------------------------------------------------------------------------
console.log("\n[2] 上升结构：收盘突破前高 → BOS bullish");
{
  // H1 = 110 (index 2, 确认于 4) → 价格上穿 110 → BOS bullish
  // L1 = 100 (index 5, 确认于 7) → 途中不破
  // H2 = 114 (index 10, 确认于 12) → 再上穿 → 又一个 BOS bullish
  const candles: Candle[] = [
    bar(0, 105, 106, 104, 105),
    bar(1, 106, 108, 105, 107),
    bar(2, 108, 110, 107, 109), // swing high 110
    bar(3, 108, 109, 106, 107),
    bar(4, 106, 107, 104, 105),
    bar(5, 104, 105, 100, 101), // swing low 100
    bar(6, 102, 104, 101, 103),
    bar(7, 104, 106, 103, 105),
    bar(8, 106, 109, 105, 108),
    bar(9, 108, 112, 107, 111), // 收盘 111 > 110 → 突破 H1
    bar(10, 112, 114, 111, 113), // swing high 114
    bar(11, 112, 113, 110, 111),
    bar(12, 110, 112, 108, 109), // H2 在此确认
    bar(13, 114, 118, 113, 117), // 收盘 117 > 114 → 突破 H2
  ];

  const swings = [
    sp(2, "high", 110, undefined, true),
    sp(5, "low", 100, undefined, true),
    sp(10, "high", 114, "HH"),
  ];
  const { bos, choch } = detectStructure(candles, swings);
  assert(bos.length === 2, `BOS 数量 = ${bos.length}（期望 2：破 H1 + 破 H2）`);
  assert(bos[0]?.type === "bullish", `BOS 方向 = ${bos[0]?.type}（期望 bullish）`);
  assert(bos[0]?.level === 110, `第一个 BOS 结构位 = ${bos[0]?.level}（期望 110）`);
  assert(bos[0]?.time === candles[9].time, "第一个 BOS 时间 = 突破那根 K（第 9 根）");
  assert(bos[1]?.level === 114, `第二个 BOS 结构位 = ${bos[1]?.level}（期望 114）`);
  assert(bos[1]?.time === candles[13].time, "第二个 BOS 时间 = 突破那根 K（第 13 根）");
  assert(bos[0]?.swingPoint.index === 2, "BOS 记录了被破的 swing");
  assert(choch.length === 0, `CHoCH 数量 = ${choch.length}（期望 0）`);
}

// ---------------------------------------------------------------------------
console.log("\n[3] 上升结构中跌破结构低 → CHoCH bearish（趋势翻转）");
{
  const candles: Candle[] = [
    bar(0, 105, 106, 104, 105),
    bar(1, 106, 108, 105, 107),
    bar(2, 108, 110, 107, 109),
    bar(3, 108, 109, 106, 107),
    bar(4, 106, 107, 104, 105),
    bar(5, 104, 105, 100, 101),
    bar(6, 102, 104, 101, 103),
    bar(7, 104, 106, 103, 105),
    bar(8, 106, 109, 105, 108),
    bar(9, 108, 112, 107, 111),
    bar(10, 112, 114, 111, 113),
    bar(11, 112, 113, 110, 111),
    bar(12, 110, 112, 108, 109),
    bar(13, 114, 118, 113, 117),
    bar(14, 108, 109, 105, 106),
    bar(15, 100, 101, 94, 95), // 收盘 95 < 100 → 跌破结构低
  ];

  const swings = [
    sp(2, "high", 110, undefined, true),
    sp(5, "low", 100, undefined, true),
    sp(10, "high", 114, "HH"),
  ];
  const { bos, choch } = detectStructure(candles, swings);
  assert(bos.length === 2 && bos.every((b) => b.type === "bullish"), "先出现 2 个 BOS bullish");
  assert(choch.length === 1, `CHoCH 数量 = ${choch.length}（期望 1）`);
  assert(choch[0]?.type === "bearish", `CHoCH 方向 = ${choch[0]?.type}（期望 bearish）`);
  assert(choch[0]?.previousTrend === "up", "CHoCH 记录了突破前的趋势 up");
  assert(choch[0]?.level === 100, `CHoCH 结构位 = ${choch[0]?.level}（期望 100）`);
  assert(choch[0]?.time === candles[15].time, "CHoCH 时间 = 跌破那根 K");
  assert(choch[0]?.swingPoint.index === 5, "CHoCH 记录了被破的 swing");
}

// ---------------------------------------------------------------------------
console.log("\n[4] CHoCH 后趋势翻转 → 随后的破低变成 BOS bearish");
{
  const candles: Candle[] = [
    bar(0, 105, 106, 104, 105),
    bar(1, 106, 108, 105, 107),
    bar(2, 108, 110, 107, 109),
    bar(3, 108, 109, 106, 107),
    bar(4, 106, 107, 104, 105),
    bar(5, 104, 105, 100, 101),
    bar(6, 102, 104, 101, 103),
    bar(7, 104, 106, 103, 105),
    bar(8, 106, 109, 105, 108),
    bar(9, 108, 112, 107, 111),
    bar(10, 112, 114, 111, 113),
    bar(11, 112, 113, 110, 111),
    bar(12, 110, 112, 108, 109),
    bar(13, 114, 118, 113, 117),
    bar(14, 108, 109, 105, 106),
    bar(15, 100, 101, 94, 95), // 跌破 100 → CHoCH bearish，trend = down
    bar(16, 94, 95, 90, 91), // swing low 90（确认于 18）
    bar(17, 91, 92, 88, 89),
    bar(18, 89, 90, 87, 88), // L2 在此确认，收盘 88 < 90 → 破低
  ];

  const swings = [
    sp(2, "high", 110, undefined, true),
    sp(5, "low", 100, undefined, true),
    sp(10, "high", 114, "HH"),
    sp(16, "low", 90, "LL"),
  ];
  const { bos, choch } = detectStructure(candles, swings);
  assert(choch.length === 1 && choch[0].type === "bearish", "CHoCH bearish 出现");
  const bearBos = bos.filter((b) => b.type === "bearish");
  assert(bearBos.length === 1, `bearish BOS 数量 = ${bearBos.length}（期望 1，趋势翻转后顺势）`);
  assert(bearBos[0]?.level === 90, `bearish BOS 结构位 = ${bearBos[0]?.level}（期望 90）`);
  assert(
    bos.filter((b) => b.type === "bullish").length === 2,
    `bullish BOS 仍为 2 个（实际 ${bos.filter((b) => b.type === "bullish").length}）`
  );
}

// ---------------------------------------------------------------------------
console.log("\n[5] 下降结构：跌破前低 → BOS bearish");
{
  const candles: Candle[] = [
    bar(0, 110, 112, 108, 111), // swing high 112
    bar(1, 108, 109, 105, 106),
    bar(2, 104, 105, 100, 101), // swing low 100（确认于 4）
    bar(3, 101, 102, 99, 100), // 收盘 100，未破
    bar(4, 100, 101, 98, 99), // 收盘 99 < 100 → 跌破结构低
  ];

  const swings = [sp(0, "high", 112, undefined, true), sp(2, "low", 100, undefined, true)];
  const { bos, choch } = detectStructure(candles, swings);
  assert(bos.length === 1, `BOS 数量 = ${bos.length}（期望 1）`);
  assert(bos[0]?.type === "bearish", `BOS 方向 = ${bos[0]?.type}（期望 bearish）`);
  assert(bos[0]?.level === 100, `BOS 结构位 = ${bos[0]?.level}（期望 100）`);
  assert(bos[0]?.time === candles[4].time, "BOS 时间 = 跌破那根 K");
  assert(choch.length === 0, `CHoCH 数量 = ${choch.length}（期望 0）`);
}

// ---------------------------------------------------------------------------
console.log("\n[6] 只破影线、收盘没收回 → 不算突破，但该位仍是「下一个 BOS」（实线标记）");
{
  // 用户口径：突破看**实体（收盘价）**；影线插破只是扫荡。
  // 于是「07-01 那个 LL 被影线破了」→ 不产生 BOS 事件，
  // 但它仍然是当前最近的未破结构位 → 渲染层用**实线**标成「下一个 BOS」。
  const candles: Candle[] = [
    bar(0, 110, 112, 108, 111),
    bar(1, 108, 109, 105, 106),
    bar(2, 104, 105, 100, 101), // swing low 100（确认于 4）
    bar(3, 101, 102, 100, 101), // 影线正好触及 100（相等，不算破）
    bar(4, 100, 101, 96, 100), // 影线插到 96 < 100，但收盘 100 没破 → 扫荡
    bar(5, 100, 101, 96, 99), // 收盘 99 < 100 → 这才是真正的突破
  ];

  const swings = [sp(0, "high", 112, undefined, true), sp(2, "low", 100, undefined, true)];

  // 只跑到第 4 根（仅影线破）→ 无事件，但 100 仍是下方的**门槛位**
  const mid = detectStructure(candles.slice(0, 5), swings);
  assert(mid.bos.length === 0 && mid.choch.length === 0, "仅影线破位不产生任何事件");
  assert(
    mid.projection.bearish?.triggerLevel === 100,
    `仅影线破位时该位仍是下方门槛 = ${mid.projection.bearish?.triggerLevel}（期望 100）`
  );
  assert(
    mid.projection.bearish?.level === 96,
    `门槛下方的目标位 = ${mid.projection.bearish?.level}（期望 96，实时极值）`
  );
  assert(mid.projection.bearish?.kind === "bos", `下方目标类型 = ${mid.projection.bearish?.kind}（期望 bos）`);

  // 收盘真正破掉之后 → 报 BOS bearish，预测位随之消失
  const { bos, choch, projection } = detectStructure(candles, swings);
  assert(bos.length === 1, `BOS 数量 = ${bos.length}（期望 1）`);
  assert(bos[0]?.type === "bearish", `BOS 方向 = ${bos[0]?.type}（期望 bearish）`);
  assert(bos[0]?.level === 100, `BOS 结构位 = ${bos[0]?.level}（期望 100）`);
  assert(bos[0]?.time === candles[5].time, "BOS 时间 = 收盘破位那根 K（第 5 根）");
  assert(choch.length === 0, `CHoCH 数量 = ${choch.length}（期望 0）`);
  assert(projection.bearish === null, "破掉之后该位不再出现在门槛/目标里");
}

// ---------------------------------------------------------------------------
console.log("\n[7] 同一结构位不会被重复触发");
{
  const candles: Candle[] = [
    bar(0, 105, 106, 104, 105),
    bar(1, 106, 108, 105, 107),
    bar(2, 108, 110, 107, 109), // swing high 110
    bar(3, 108, 109, 106, 107),
    bar(4, 106, 107, 104, 105),
    bar(5, 104, 105, 100, 101), // swing low 100
    bar(6, 102, 104, 101, 103),
    bar(7, 104, 106, 103, 105),
    bar(8, 106, 108, 105, 107),
    bar(9, 107, 110, 106, 109), // 收盘 109，未破 110
    bar(10, 109, 114, 108, 112), // 收盘 112 > 110 → 突破 H1
    bar(11, 112, 115, 111, 113),
    bar(12, 113, 116, 112, 114), // 收盘 114，未破 115
    bar(13, 114, 118, 113, 116), // 收盘 116 > 115 → 突破 H2
    bar(14, 116, 119, 115, 117), // 继续涨，但已突破的位不会再报
  ];

  const swings = [
    sp(2, "high", 110, undefined, true),
    sp(6, "low", 100, undefined, true),
    sp(11, "high", 115, "HH", false, 1),
  ];
  const { bos } = detectStructure(candles, swings);
  assert(bos.length === 2, `BOS 数量 = ${bos.length}（期望 2：每个结构位只报一次）`);
  assert(bos[0]?.level === 110, `第一个 BOS 结构位 = ${bos[0]?.level}（期望 110）`);
  assert(bos[1]?.level === 115, `第二个 BOS 结构位 = ${bos[1]?.level}（期望 115）`);
}

// ---------------------------------------------------------------------------
console.log("\n[8] 分类：第一个高点/低点标记 firstOfType，后续按相对高低分类");
{
  const pivots = [
    { type: "regular" as const, pivotType: "high" as const, price: 110, time: 1, index: 1, barIndex: 0, confirmIndex: 1 },
    { type: "regular" as const, pivotType: "low" as const, price: 100, time: 2, index: 2, barIndex: 0, confirmIndex: 2 },
    { type: "regular" as const, pivotType: "high" as const, price: 120, time: 3, index: 3, barIndex: 0, confirmIndex: 3 },
    { type: "regular" as const, pivotType: "low" as const, price: 105, time: 4, index: 4, barIndex: 0, confirmIndex: 4 },
    { type: "regular" as const, pivotType: "high" as const, price: 115, time: 5, index: 5, barIndex: 0, confirmIndex: 5 },
    { type: "regular" as const, pivotType: "low" as const, price: 95, time: 6, index: 6, barIndex: 0, confirmIndex: 6 },
  ];
  const cls = classifyPivots(pivots);
  assert(cls[0].classification === "LH" && cls[0].firstOfType === true, "第一个高点 firstOfType=true");
  assert(cls[1].classification === "LL" && cls[1].firstOfType === true, "第一个低点 firstOfType=true");
  assert(cls[2].classification === "HH", `第二个高点 = ${cls[2].classification}（期望 HH）`);
  assert(cls[3].classification === "HL", `第二个低点 = ${cls[3].classification}（期望 HL）`);
  assert(cls[4].classification === "LH", `第三个高点 = ${cls[4].classification}（期望 LH）`);
  assert(cls[5].classification === "LL", `第三个低点 = ${cls[5].classification}（期望 LL）`);
  assert(cls.slice(2).every((c) => c.firstOfType === undefined), "非首个摆动点不带 firstOfType");
}

// ---------------------------------------------------------------------------
console.log("\n[9] 回放评分依赖的 classification 值未改变（entryQuality 口径）");
{
  const pivots = [
    { type: "regular" as const, pivotType: "high" as const, price: 110, time: 1, index: 1, barIndex: 0, confirmIndex: 1 },
    { type: "regular" as const, pivotType: "low" as const, price: 100, time: 2, index: 2, barIndex: 0, confirmIndex: 2 },
    { type: "regular" as const, pivotType: "high" as const, price: 120, time: 3, index: 3, barIndex: 0, confirmIndex: 3 },
  ];
  const cls = classifyPivots(pivots);
  // entryQuality: "HH"|"HL" → 多头(1)，"LH"|"LL" → 空头(-1)
  const structure = (c: string) => (c === "HH" || c === "HL" ? 1 : -1);
  assert(structure(cls[cls.length - 1].classification) === 1, "最后一个 swing 判定为多头结构(1)");
  assert(structure(cls[0].classification) === -1, "第一个 swing 仍判定为空头结构(-1)，与改动前一致");
}

// ---------------------------------------------------------------------------
console.log("\n[10] 无前视：截断 K 线重跑，前面的信号必须完全一致");
{
  const candles: Candle[] = [
    bar(0, 105, 106, 104, 105),
    bar(1, 106, 108, 105, 107),
    bar(2, 108, 110, 107, 109),
    bar(3, 108, 109, 106, 107),
    bar(4, 106, 107, 104, 105),
    bar(5, 104, 105, 100, 101),
    bar(6, 102, 104, 101, 103),
    bar(7, 104, 106, 103, 105),
    bar(8, 106, 109, 105, 108),
    bar(9, 108, 112, 107, 111),
    bar(10, 112, 114, 111, 113),
    bar(11, 112, 113, 110, 111),
    bar(12, 110, 112, 108, 109),
    bar(13, 114, 118, 113, 117),
    bar(14, 108, 109, 105, 106),
    bar(15, 100, 101, 94, 95),
  ];
  const swings = [
    sp(2, "high", 110, undefined, true),
    sp(5, "low", 100, undefined, true),
    sp(10, "high", 114, "HH"),
  ];
  const full = allSignals(detectStructure(candles, swings));
  for (const k of [6, 10, 14, 16]) {
    const prefixCandles = candles.slice(0, k);
    const prefix = allSignals(detectStructure(prefixCandles, swings));
    const cutoff = prefixCandles[prefixCandles.length - 1].time;
    const expected = full.filter((s) => s.time <= cutoff);
    const same =
      prefix.length === expected.length &&
      prefix.every((s, i) => s.time === expected[i].time && s.level === expected[i].level && s.kind === expected[i].kind);
    assert(
      same,
      `截断到 ${k} 根时信号一致（前缀 ${prefix.length} 条 / 完整数据同段 ${expected.length} 条）`
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\n[11] 一根 K 越过多个结构位 → 每个被越过的位都单独报（之前只报队尾，其余被静默丢弃）");
{
  // H1=110（HH 前的那个）、H2=108（LH，较低的高点）
  // 两层都还没破，直到第 10 根一根大 K 影线冲到 113 → 108 与 110 同时被破
  const candles: Candle[] = [
    bar(0, 100, 102, 99, 101),
    bar(1, 101, 104, 100, 103),
    bar(2, 103, 110, 102, 108), // swing high 110（确认于 4）
    bar(3, 108, 109, 103, 104),
    bar(4, 104, 105, 100, 101), // H1 在此确认
    bar(5, 101, 102, 99, 100),
    bar(6, 100, 101, 98, 99),
    bar(7, 99, 108, 99, 107), // swing high 108 = LH（确认于 9），未破 110
    bar(8, 107, 107.5, 100, 101),
    bar(9, 101, 102, 99, 100), // H2 在此确认
    bar(10, 100, 113, 99, 112), // 影线 113 同时越过 108 与 110
    bar(11, 112, 114, 111, 113),
  ];
  const swings = [
    sp(2, "high", 110, undefined, true),
    sp(7, "high", 108, "LH"),
  ];
  const { bos, choch } = detectStructure(candles, swings);
  assert(
    bos.length + choch.length === 2,
    `两个被越过的位都要报（BOS ${bos.length} + CHoCH ${choch.length}，期望 2）`
  );
  // 价格自下而上 → 先穿价位低的（108）
  assert(choch.length === 1 && choch[0]?.level === 108, `第一个事件 = CHoCH @${choch[0]?.level}（期望 108，逆势破 LH）`);
  assert(choch[0]?.type === "bullish", "第一个事件方向 = bullish");
  assert(choch[0]?.previousTrend === "down", "CHoCH 记录了突破前的趋势 down");
  assert(bos.length === 1 && bos[0]?.level === 110, `第二个事件 = BOS @${bos[0]?.level}（期望 110，顺势）`);
  assert(bos[0]?.type === "bullish", "第二个事件方向 = bullish");
  assert(
    choch[0]?.time === candles[10].time && bos[0]?.time === candles[10].time,
    "两条都在突破那根 K 报出"
  );
}

// ---------------------------------------------------------------------------
console.log("\n[12] 未确认的摆动点（右窗口不完整）不参与判定");
{
  const candles: Candle[] = [
    bar(0, 105, 106, 104, 105),
    bar(1, 106, 108, 105, 107),
    bar(2, 108, 110, 107, 109),
    bar(3, 108, 109, 106, 107),
    bar(4, 106, 107, 104, 105),
    bar(5, 104, 105, 100, 101),
    bar(6, 102, 104, 101, 103),
    bar(7, 104, 106, 103, 105),
    bar(8, 106, 109, 105, 108),
    bar(9, 108, 112, 107, 111),
    bar(10, 112, 114, 111, 113),
    bar(11, 112, 113, 110, 111),
    bar(12, 110, 112, 108, 109),
    bar(13, 114, 118, 113, 117),
  ];
  const confirmed = [
    sp(2, "high", 110, undefined, true),
    sp(5, "low", 100, undefined, true),
    sp(10, "high", 114, "HH"),
  ];
  // 末尾临时 pivot：确认点 15 > 末根 13，且价格落在最后收盘之上
  const withTail = [...confirmed, sp(13, "high", 116, "HH", false, 2)];

  const a = allSignals(detectStructure(candles, confirmed));
  const b = allSignals(detectStructure(candles, withTail));
  assert(
    a.length === b.length && a.every((s, i) => s.time === b[i].time && s.level === b[i].level),
    `未确认的 pivot 不改变结果（${a.length} 条 vs ${b.length} 条）`
  );
}

// ---------------------------------------------------------------------------
console.log("\n[13] 下降结构里上破最近的低高点 → CHoCH bullish（逆势突破）");
{
  const candles: Candle[] = [
    bar(0, 115, 117, 113, 116),
    bar(1, 116, 118, 114, 117),
    bar(2, 118, 120, 117, 119), // swing high 120（确认于 4）
    bar(3, 118, 119, 115, 116),
    bar(4, 115, 116, 112, 113),
    bar(5, 112, 113, 105, 106),
    bar(6, 105, 106, 100, 101), // swing low 100（确认于 8）
    bar(7, 101, 102, 99, 100),
    bar(8, 100, 101, 98, 99), // 收盘 99 < 100 → 破低 → BOS bearish
    bar(9, 99, 104, 98, 103),
    bar(10, 104, 110, 103, 109), // swing high 110（LH，确认于 12）
    bar(11, 109, 111, 108, 110),
    bar(12, 110, 112, 109, 111), // H2 在此确认
    bar(13, 112, 116, 111, 115), // 收盘 115 > 110 → 逆势上破
  ];
  const swings = [
    sp(2, "high", 120, undefined, true),
    sp(6, "low", 100, undefined, true),
    sp(10, "high", 110, "LH"),
  ];
  const { bos, choch } = detectStructure(candles, swings);
  const bearBos = bos.filter((b) => b.type === "bearish");
  assert(bearBos.length === 1, `bearish BOS 数量 = ${bearBos.length}（期望 1）`);
  assert(bearBos[0]?.level === 100, `bearish BOS 结构位 = ${bearBos[0]?.level}（期望 100）`);
  assert(choch.length === 1, `CHoCH 数量 = ${choch.length}（期望 1）`);
  assert(choch[0]?.type === "bullish", `CHoCH 方向 = ${choch[0]?.type}（期望 bullish）`);
  assert(choch[0]?.previousTrend === "down", "CHoCH 记录了突破前的趋势 down");
  assert(choch[0]?.level === 110, `CHoCH 结构位 = ${choch[0]?.level}（期望 110）`);
}

// ---------------------------------------------------------------------------
console.log("\n[14] 预测下一个 BOS / CHoCH 的目标位（门槛 = 最近结构位，目标 = 外侧下一个）");
{
  // 上升结构收尾：
  //   上方 H3=120（门槛） / H4=132（目标）
  //   下方 L1=100（门槛） / L2=90（目标）
  const candles: Candle[] = [
    bar(0, 105, 106, 104, 105),
    bar(1, 106, 108, 105, 107),
    bar(2, 108, 110, 107, 109), // H1 110（确认于 4）
    bar(3, 108, 109, 100, 107), // 低点 100 → L2 90 在此形成（确认于 5）
    bar(4, 106, 107, 104, 105),
    bar(5, 104, 105, 100, 101), // L1 100（确认于 7）
    bar(6, 102, 104, 101, 103),
    bar(7, 104, 106, 103, 105),
    bar(8, 106, 109, 105, 108),
    bar(9, 108, 112, 107, 111), // 收盘 111 > 110 → BOS bullish，trend=up
    bar(10, 112, 114, 111, 113), // H2 114（确认于 12）
    bar(11, 112, 113, 110, 111),
    bar(12, 110, 112, 108, 109),
    bar(13, 114, 118, 113, 117), // 收盘 117 > 114 → BOS bullish
    bar(14, 116, 117, 112, 114),
    bar(15, 114, 116, 111, 113),
    bar(16, 113, 120, 112, 118), // H3 120（确认于 18）
    bar(17, 118, 119, 114, 116),
    bar(18, 116, 132, 113, 118), // 长上影冲到 132、收盘 118（不破 120）→ H4 132（确认于 19）
    bar(19, 115, 116, 112, 114),
  ];
  const swings = [
    sp(3, "low", 90),
    sp(2, "high", 110, undefined, true),
    sp(5, "low", 100, undefined, true),
    sp(10, "high", 114, "HH"),
    sp(16, "high", 120, "HH"),
    sp(18, "high", 132, "HH", false, 1),
  ];

  const { projection } = detectStructure(candles, swings);
  const lastClose = candles[candles.length - 1].close;

  assert(projection.bullish !== null, "存在上方目标");
  assert(projection.bearish !== null, "存在下方目标");
  // 上方：门槛 = 最近的未破高点 120，目标 = 外侧下一个 132
  assert(projection.bullish?.triggerLevel === 120, `上方门槛 = ${projection.bullish?.triggerLevel}（期望 120）`);
  assert(projection.bullish?.level === 132, `上方目标 = ${projection.bullish?.level}（期望 132）`);
  // 下方：门槛 = 最近的未破低点 100，目标 = 外侧下一个 90
  assert(projection.bearish?.triggerLevel === 100, `下方门槛 = ${projection.bearish?.triggerLevel}（期望 100）`);
  assert(projection.bearish?.level === 90, `下方目标 = ${projection.bearish?.level}（期望 90）`);
  assert((projection.bullish?.level ?? 0) > lastClose, "上方目标在现价之上");
  assert((projection.bearish?.level ?? 0) < lastClose, "下方目标在现价之下");
  // 多头趋势：上方是顺势(BOS)，下方是逆势(CHoCH)
  assert(projection.bullish?.kind === "bos", `上方目标类型 = ${projection.bullish?.kind}（期望 bos，顺势）`);
  assert(projection.bearish?.kind === "choch", `下方目标类型 = ${projection.bearish?.kind}（期望 choch，逆势）`);
  assert(projection.bullish?.direction === "bullish", "上方目标方向 = bullish");
  assert(projection.bearish?.direction === "bearish", "下方目标方向 = bearish");
  assert(projection.bullish?.swingPoint.index === 18, "上方目标绑定到 H4 摆动点");

  // 门槛被收盘越过 → 引擎真的报出事件（渲染层据此画出虚线事件线）
  const touched = [
    ...candles,
    bar(20, 115, 125, 114, 124), // 收盘 124 > 120 → 破掉门槛 120
  ];
  const after = detectStructure(touched, swings);
  const lastBos = after.bos[after.bos.length - 1];
  assert(lastBos?.level === 120, `触及后报出 BOS 结构位 = ${lastBos?.level}（期望 120）`);
  assert(lastBos?.time === touched[20].time, "触及后事件时间 = 破位那根 K");
  // 门槛破掉后它自己从候选里消失 → 上方只剩 132 一个位，没有更远的目标
  assert(after.projection.bullish === null, "触及后上方没有更远的目标了（只剩门槛 132）");
  assert(after.projection.bearish?.triggerLevel === 100, "触及后下方门槛不变");
  assert(after.projection.bearish?.level === 90, "触及后下方目标不变");
}

// ---------------------------------------------------------------------------
console.log("\n[15] 预测层实时：未确认的新低立刻成为目标位（不等 pivot 右侧确认）");
{
  // L1=100 是已确认的结构位；最后一根 K 插破到 95 但收盘没破 →
  // 95 就是「LL 底下的目标」，实时反映，不用等 29 根 K 确认。
  const candles: Candle[] = [
    bar(0, 105, 106, 104, 105),
    bar(1, 106, 108, 105, 107),
    bar(2, 108, 110, 107, 109), // H1 110（确认于 4）
    bar(3, 108, 109, 100, 107),
    bar(4, 106, 107, 100, 105),
    bar(5, 104, 105, 100, 101), // L1 100（确认于 7）
    bar(6, 102, 104, 101, 103),
    bar(7, 104, 106, 103, 105),
    bar(8, 106, 109, 105, 108),
    bar(9, 108, 112, 107, 111), // 收盘 111 > 110 → BOS bullish
    bar(10, 112, 114, 111, 113),
    bar(11, 112, 113, 110, 111),
    bar(12, 110, 112, 108, 109),
    bar(13, 114, 118, 113, 117), // 收盘 117 > 114 → BOS bullish
    bar(14, 116, 117, 112, 114),
    bar(15, 114, 116, 111, 113),
    bar(16, 113, 120, 112, 118), // H2 120（确认于 18）
    bar(17, 118, 119, 114, 116),
    bar(18, 116, 117, 113, 115),
    bar(19, 115, 116, 112, 114),
    bar(20, 113, 114, 95, 101), // 插破到 95（收盘 101 没破 100）
  ];
  const swings = [
    sp(2, "high", 110, undefined, true),
    sp(5, "low", 100, undefined, true),
    sp(16, "high", 120, "HH"),
  ];

  const r = detectStructure(candles, swings);
  assert(r.projection.bearish?.triggerLevel === 100, `下方门槛 = ${r.projection.bearish?.triggerLevel}（期望 100）`);
  assert(r.projection.bearish?.level === 95, `实时目标位 = ${r.projection.bearish?.level}（期望 95，未确认的新低）`);
  // 实时极值**不参与事件判定** → 不能因为 95 就凭空多出 BOS/CHoCH
  assert(r.bos.length === 1 && r.choch.length === 0, `事件数不受实时极值影响（BOS ${r.bos.length} / CHoCH ${r.choch.length}，期望 1 / 0）`);

  // 再插破到 94（收盘 96 仍在 100 之上）→ 实时目标跟着下移
  const moved = [...candles, bar(21, 101, 102, 94, 102)]; // 插破到 94，但收盘 102 仍在门槛 100 之上
  const r2 = detectStructure(moved, swings);
  assert(r2.projection.bearish?.triggerLevel === 100, `门槛不变 = ${r2.projection.bearish?.triggerLevel}（期望 100）`);
  assert(r2.projection.bearish?.level === 94, `实时目标下移到 = ${r2.projection.bearish?.level}（期望 94）`);
  assert(r2.bos.length === 1 && r2.choch.length === 0, "继续插破也不产生新事件（只有收盘才算突破）");

  // 收盘真的跌破 → 门槛 100 与实时目标一起被破坏，下方只剩一个新的实时低点
  const broke = [...candles, bar(21, 101, 102, 94, 102), bar(22, 95, 96, 92, 93)];
  const r3 = detectStructure(broke, swings);
  assert(r3.projection.bearish === null, `收盘跌破后门槛与目标一起消失（bearish = ${r3.projection.bearish === null ? "null" : r3.projection.bearish.level}）`);
}

console.log(
  failed === 0 ? "\n✅ 市场结构(BOS/CHoCH)自检全部通过\n" : `\n❌ ${failed} 项断言失败\n`
);
process.exit(failed === 0 ? 0 : 1);
