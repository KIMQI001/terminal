import { HistogramData, Time } from "lightweight-charts";
import { Candle } from "@/types/chart";

/**
 * K 线显示模式
 * - normal: 全部显示
 * - short (S, 做空): 只显示「当前价格以上」的阳线
 * - long  (L, 做多): 只显示「当前价格以下」的阴线
 */
export type KlineDisplayMode = "normal" | "short" | "long";

/**
 * 判断某根 K 线在当前模式下是否可见。
 *
 * @param anchor 「当前价格」锚点 —— 实时 K 的最新收盘价(每 tick 跟随)。
 * @param isLive 该根是否为「实时 K」(序列最后一根,正在形成)。
 *               正在形成的这根 K 代表当前价格,过滤模式下一律**保留显示**,
 *               不参与「现价以上 / 以下」的筛选。
 */
export function isCandleVisible(
  c: Candle,
  mode: KlineDisplayMode,
  anchor: number | null,
  isLive = false
): boolean {
  if (mode === "normal" || anchor === null) return true;
  // 实时 K(正在形成的那根)永远显示
  if (isLive) return true;
  const bullish = c.close > c.open;
  const bearish = c.close < c.open;
  // S(做空):只留现价上方的阳线
  if (mode === "short") return bullish && c.close > anchor;
  // L(做多):只留现价下方的阴线
  return bearish && c.close < anchor;
}

/**
 * 只保留可见条目 —— 被隐藏的 K 线不进入蜡烛 / 折线序列,自然不会被绘制。
 * 注意:lightweight-charts v4 的 setData 会丢弃 whitespace 占位,时间轴会因此塌陷,
 * 所以这里采用「直接不放入」的方式,时间点由成交量序列兜底(见 maskHiddenVolume)。
 *
 * items 与 candles 按下标一一对应;candles 的最后一根是「实时 K」,永远不显示。
 */
export function filterVisibleItems<T extends { time: Time }>(
  items: T[],
  candles: Candle[],
  mode: KlineDisplayMode,
  anchor: number | null
): T[] {
  if (mode === "normal" || anchor === null) return items;
  const lastIdx = candles.length - 1;
  return items.filter((_, i) => {
    const c = candles[i];
    return c ? isCandleVisible(c, mode, anchor, i === lastIdx) : true;
  });
}

/**
 * 成交量序列:隐藏的 K 线成交量置 0(柱子不可见),但**保留时间点**。
 * 成交量与蜡烛共用同一条时间轴,只要它保留全部时间点,
 * 时间轴就不会因为蜡烛被过滤而塌陷 / 重新锚定,用户的缩放与平移得以保留。
 */
export function maskHiddenVolume(
  items: HistogramData<Time>[],
  candles: Candle[],
  mode: KlineDisplayMode,
  anchor: number | null
): HistogramData<Time>[] {
  if (mode === "normal" || anchor === null) return items;
  const lastIdx = candles.length - 1;
  return items.map((item, i) => {
    const c = candles[i];
    if (c && !isCandleVisible(c, mode, anchor, i === lastIdx)) {
      return { time: item.time, value: 0, color: "rgba(0,0,0,0)" };
    }
    return item;
  });
}

/**
 * 计算过滤后可见 K 线的时间点列表。
 * 用于实时行情刷新时判断「可见集合」是否变化 —— 没变化就不必整段 setData 重建。
 */
export function computeVisibleTimes(
  candles: Candle[],
  mode: KlineDisplayMode,
  anchor: number | null
): number[] {
  if (mode === "normal" || anchor === null) return candles.map((c) => c.time);
  const lastIdx = candles.length - 1;
  const times: number[] = [];
  candles.forEach((c, i) => {
    if (isCandleVisible(c, mode, anchor, i === lastIdx)) times.push(c.time);
  });
  return times;
}

/** 两个时间点列表是否完全一致(顺序也一致) */
export function isSameTimeList(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
