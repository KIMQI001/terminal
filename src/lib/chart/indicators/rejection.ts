/**
 * 拒绝 K 线(Rejection Candle)检测器
 *
 * 与 Engulfing Pinbar 不同:engulfingPinbar 要求"吞没前一根",
 * rejection 只要求单根 K 线本身具备"拒绝"形态(长影线 + 小实体)。
 *
 * 规则:
 * - 看涨: 长下影 + 小实体 + 短(或无)上影
 *   - 下影长度 >= 2 × 实体
 *   - 上影长度 <= 0.5 × 实体
 *   - 实体占整 K 比例 < 0.4
 * - 看跌: 长上影 + 小实体 + 短(或无)下影(对称条件)
 */

import { Candle } from "@/types/chart";
import { Rejection } from "@/types/indicator";

/** 默认阈值:wick/body 最小比例,低于此不算"长影线" */
const DEFAULT_MIN_WICK_BODY_RATIO = 2.0;
/** 默认阈值:反向影线最大占实体比例 */
const DEFAULT_MAX_OPPOSITE_WICK_RATIO = 0.5;
/** 默认阈值:实体占整 K 最大比例 */
const DEFAULT_MAX_BODY_RATIO = 0.4;

export interface RejectionOptions {
  minWickBodyRatio?: number;
  maxOppositeWickRatio?: number;
  maxBodyRatio?: number;
}

/**
 * 检测拒绝 K 线
 *
 * @param candles - K线数据
 * @param options - 阈值参数(可选,默认见 DEFAULT_* 常量)
 */
export function detectRejections(
  candles: Candle[],
  options: RejectionOptions = {}
): Rejection[] {
  const minWickBodyRatio = options.minWickBodyRatio ?? DEFAULT_MIN_WICK_BODY_RATIO;
  const maxOppositeWickRatio = options.maxOppositeWickRatio ?? DEFAULT_MAX_OPPOSITE_WICK_RATIO;
  const maxBodyRatio = options.maxBodyRatio ?? DEFAULT_MAX_BODY_RATIO;

  const results: Rejection[] = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const bodyTop = Math.max(candle.open, candle.close);
    const bodyBottom = Math.min(candle.open, candle.close);
    const bodySize = bodyTop - bodyBottom;
    const totalRange = candle.high - candle.low;

    // 跳过十字星(bodySize=0)
    if (bodySize <= 0 || totalRange <= 0) continue;

    const upperWick = candle.high - bodyTop;
    const lowerWick = bodyBottom - candle.low;

    const bodyRatio = bodySize / totalRange;

    // === 看涨拒绝(长下影) ===
    // 条件:下影够长 / 上影够短 / 实体占比小
    if (
      lowerWick >= minWickBodyRatio * bodySize &&
      upperWick <= maxOppositeWickRatio * bodySize &&
      bodyRatio <= maxBodyRatio
    ) {
      const wickSize = lowerWick;
      results.push({
        type: "bullish",
        time: candle.time,
        index: i,
        // wick 区域:从 candle.low 到 bodyTop(包含整根下影 + 实体上沿)
        high: bodyTop,
        low: candle.low,
        mid: (bodyTop + candle.low) / 2,
        wickSize,
        bodySize,
        wickBodyRatio: wickSize / bodySize,
        candleHigh: candle.high,
        candleLow: candle.low,
      });
    }

    // === 看跌拒绝(长上影) ===
    if (
      upperWick >= minWickBodyRatio * bodySize &&
      lowerWick <= maxOppositeWickRatio * bodySize &&
      bodyRatio <= maxBodyRatio
    ) {
      const wickSize = upperWick;
      results.push({
        type: "bearish",
        time: candle.time,
        index: i,
        // wick 区域:从 bodyBottom 到 candle.high
        high: candle.high,
        low: bodyBottom,
        mid: (candle.high + bodyBottom) / 2,
        wickSize,
        bodySize,
        wickBodyRatio: wickSize / bodySize,
        candleHigh: candle.high,
        candleLow: candle.low,
      });
    }
  }

  // 只保留最近的 30 条
  return results.slice(-30);
}
