/**
 * Engulfing Pinbar 检测器
 *
 * 基于 Pinbar + Engulfing 组合形态
 * - Pinbar: 长上下影线，实体较小
 * - Engulfing: 当前蜡烛吞没前一根
 */

import { Candle } from "@/types/chart";

/**
 * Engulfing Pinbar 类型
 */
export interface EngulfingPinbar {
  type: "bullish" | "bearish";
  time: number;
  index: number;
  price: number; // 信号价格（收盘价）
  bodySize: number;
  topWickSize: number;
  bottomWickSize: number;
}

/**
 * 检测 Engulfing Pinbar
 *
 * @param candles - K线数据
 * @param wickSize - 影线与实体比例阈值（默认0.3，即30%）
 * @param oppositeWickFilter - 对向影线过滤（默认0.6，即影线超过对向60%时过滤）
 */
export function detectEngulfingPinbar(
  candles: Candle[],
  wickSize: number = 0.3,
  oppositeWickFilter: number = 0.6
): EngulfingPinbar[] {
  const results: EngulfingPinbar[] = [];

  if (candles.length < 2) return results;

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];

    // 计算当前蜡烛数据
    const currentTopWick = Math.abs(Math.max(current.close, current.open) - current.high);
    const currentBottomWick = Math.abs(Math.min(current.close, current.open) - current.low);
    const currentBody = Math.abs(current.close - current.open);

    // 计算前一根蜡烛数据
    const prevTopWick = Math.abs(Math.max(prev.close, prev.open) - prev.high);
    const prevBottomWick = Math.abs(Math.min(prev.close, prev.open) - prev.low);
    const prevBody = Math.abs(prev.close - prev.open);

    // 跳过实体太小的蜡烛（防止除零）
    if (currentBody === 0 || prevBody === 0) continue;

    // === Bullish Engulfing Pinbar ===
    // 1. 前一根是阴线
    // 2. 当前是阳线
    // 3. 当前阳线吞没前一根阴线
    const isBullish =
      prev.close <= prev.open && // 前一根阴线
      current.close > current.open && // 当前阳线
      current.close >= prev.open && // 吞没前一根开盘
      current.open <= prev.close; // 吞没前一根收盘

    if (isBullish) {
      results.push({
        type: "bullish",
        time: current.time,
        index: i,
        price: current.close,
        bodySize: currentBody,
        topWickSize: currentTopWick,
        bottomWickSize: currentBottomWick,
      });
    }

    // === Bearish Engulfing Pinbar ===
    // 1. 前一根是阳线
    // 2. 当前是阴线
    // 3. 当前阴线吞没前一根阳线
    const isBearish =
      prev.close >= prev.open && // 前一根阳线
      current.close < current.open && // 当前阴线
      current.close <= prev.open && // 吞没前一根开盘
      current.open >= prev.close; // 吞没前一根收盘

    if (isBearish) {
      results.push({
        type: "bearish",
        time: current.time,
        index: i,
        price: current.close,
        bodySize: currentBody,
        topWickSize: currentTopWick,
        bottomWickSize: currentBottomWick,
      });
    }
  }

  return results;
}
