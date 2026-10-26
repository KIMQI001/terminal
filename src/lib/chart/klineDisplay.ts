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
 * anchor = 进入模式那一刻的现价(快照),这样可见集合不会随行情跳动。
 */
export function isCandleVisible(
  c: Candle,
  mode: KlineDisplayMode,
  anchor: number | null
): boolean {
  if (mode === "normal" || anchor === null) return true;
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
 */
export function filterVisibleItems<T extends { time: Time }>(
  items: T[],
  candles: Candle[],
  mode: KlineDisplayMode,
  anchor: number | null
): T[] {
  if (mode === "normal" || anchor === null) return items;
  return items.filter((_, i) => {
    const c = candles[i];
    return c ? isCandleVisible(c, mode, anchor) : true;
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
  return items.map((item, i) => {
    const c = candles[i];
    if (c && !isCandleVisible(c, mode, anchor)) {
      return { time: item.time, value: 0, color: "rgba(0,0,0,0)" };
    }
    return item;
  });
}
