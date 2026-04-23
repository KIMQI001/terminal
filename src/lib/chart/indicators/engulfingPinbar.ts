/**
 * Engulfing Pinbar 检测器
 *
 * 基于 Pinbar + Engulfing 组合形态
 * - Pinbar: 长上下影线，实体较小
 * - Engulfing: 当前蜡烛吞没前一根
 */

import { Candle } from "@/types/chart";
import { SwingPoint } from "@/types/chart";

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
 * @param swingPoints - Swing Points（用于过滤：看跌只在H点附近，看涨只在L点附近）
 * @param range - Swing Point 附近范围（默认5根K线）
 */
export function detectEngulfingPinbar(
  candles: Candle[],
  swingPoints: SwingPoint[] = [],
  range: number = 5
): EngulfingPinbar[] {
  const results: EngulfingPinbar[] = [];

  if (candles.length < 2) return results;

  // 构建 Swing Point 索引集合
  const swingHighIndices = new Set(
    swingPoints.filter(sp => sp.type === "high").map(sp => sp.index)
  );
  const swingLowIndices = new Set(
    swingPoints.filter(sp => sp.type === "low").map(sp => sp.index)
  );

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];

    // 计算当前蜡烛数据
    const currentTopWick = Math.abs(Math.max(current.close, current.open) - current.high);
    const currentBottomWick = Math.abs(Math.min(current.close, current.open) - current.low);
    const currentBody = Math.abs(current.close - current.open);

    // 跳过实体太小的蜡烛（防止除零）
    if (currentBody === 0) continue;

    // === Bullish Engulfing Pinbar ===
    // 条件：前一根是阴线，当前是阳线，吞没前一根
    // 额外：在 L 点附近（前后5根）
    const isBullish =
      prev.close <= prev.open && // 前一根阴线
      current.close > current.open && // 当前阳线
      current.close >= prev.open && // 吞没前一根开盘
      current.open <= prev.close; // 吞没前一根收盘

    if (isBullish) {
      // 检查是否在 L 点附近
      const nearSwingLow = swingPoints.some(sp =>
        sp.type === "low" &&
        Math.abs(i - sp.index) <= range
      );

      if (nearSwingLow || swingPoints.length === 0) {
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
    }

    // === Bearish Engulfing Pinbar ===
    // 条件：前一根是阳线，当前是阴线，吞没前一根
    // 额外：在 H 点附近（前后5根）
    const isBearish =
      prev.close >= prev.open && // 前一根阳线
      current.close < current.open && // 当前阴线
      current.close <= prev.open && // 吞没前一根开盘
      current.open >= prev.close; // 吞没前一根收盘

    if (isBearish) {
      // 检查是否在 H 点附近
      const nearSwingHigh = swingPoints.some(sp =>
        sp.type === "high" &&
        Math.abs(i - sp.index) <= range
      );

      if (nearSwingHigh || swingPoints.length === 0) {
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
  }

  return results;
}
