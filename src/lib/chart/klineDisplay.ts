import { Candle } from "@/types/chart";

/**
 * K 线显示模式
 *  - normal : 全部显示(默认)
 *  - short(S): 只显示「锚定现价以上」的阳线 —— 做空时看上方冲高留下的阳线
 *  - long (L): 只显示「锚定现价以下」的阴线 —— 做多时看下方砸盘留下的阴线
 *
 * 锚定现价(anchor) = 进入该模式那一刻的现价快照,
 * 这样图上可见的 K 线集合是稳定的,不会随行情每跳都闪烁。
 */
export type KlineDisplayMode = "normal" | "short" | "long";

/** 单根 K 线在当前模式下是否可见 */
export function isCandleVisible(
  c: Candle,
  mode: KlineDisplayMode,
  anchor: number | null
): boolean {
  if (mode === "normal" || anchor === null) return true;

  const bullish = c.close > c.open;
  const bearish = c.close < c.open;

  if (mode === "short") {
    // 做空:只留现价上方的阳线
    return bullish && c.close > anchor;
  }
  // 做多:只留现价下方的阴线
  return bearish && c.close < anchor;
}

/**
 * 按显示模式过滤一列与 candles 一一对应的数据(蜡烛 bar / 成交量 bar / 高低价点)。
 * 传入的 items 与 candles 索引一一对应。
 */
export function filterByDisplayMode<T>(
  items: T[],
  candles: Candle[],
  mode: KlineDisplayMode,
  anchor: number | null
): T[] {
  if (mode === "normal" || anchor === null) return items;

  const out: T[] = [];
  for (let i = 0; i < items.length && i < candles.length; i++) {
    if (isCandleVisible(candles[i], mode, anchor)) out.push(items[i]);
  }
  return out;
}
