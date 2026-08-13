/**
 * Rejection Zone 检测器
 *
 * 规则:
 * - 长 wick 判定(wickCandidates):
 *   - range = high - low
 *   - 上影(阻力):(high - bodyTop) / range >= minWickRatio
 *   - 下影(支撑):(bodyBottom - low) / range >= minWickRatio
 *   - 一根 K 可以同时给两个候选(长腿十字)
 *
 * - actionable level:
 *   - 阻力:level = (bodyTop + high) / 2, zone = [bodyTop, high]
 *   - 支撑:level = (low + bodyBottom) / 2, zone = [low, bodyBottom]
 *   - level 是 wick 段的中点(不是 high/low 本身)
 *
 * - 实时语义:最后一根(进行中)K 不作为 wick 来源(还在形成),
 *   但它会作为 tester 被查询(在 primitive 渲染时实时算 isTested)
 *
 * 生存过滤(isTested):后续任何 K 的 range 包住这个 level
 *   (low <= level <= high)→ 已被测试过,该 wick 失效(primitive 里擦掉)
 */

import { Candle } from "@/types/chart";
import { Rejection } from "@/types/indicator";

/** 默认:wick 占 range 最小比例 0.4 */
const DEFAULT_MIN_WICK_RATIO = 0.4;

export interface RejectionOptions {
  minWickRatio?: number;
}

/**
 * 检测 Rejection zones
 * - 最后一根 K 不作为 wick 来源(还在形成)
 * - 一根 K 可以同时给两个候选(上影 + 下影)
 */
export function detectRejections(
  candles: Candle[],
  options: RejectionOptions = {}
): Rejection[] {
  const minWickRatio = options.minWickRatio ?? DEFAULT_MIN_WICK_RATIO;
  const results: Rejection[] = [];

  // 最后一根不作为 wick 来源
  for (let i = 0; i < candles.length - 1; i++) {
    const candle = candles[i];
    const bodyTop = Math.max(candle.open, candle.close);
    const bodyBottom = Math.min(candle.open, candle.close);
    const range = candle.high - candle.low;
    if (range <= 0) continue;

    const upperWickSize = candle.high - bodyTop;
    const lowerWickSize = bodyBottom - candle.low;
    const upperWickRatio = upperWickSize / range;
    const lowerWickRatio = lowerWickSize / range;

    // 上影 = 阻力候选(bearish action level:卖出区)
    if (upperWickRatio >= minWickRatio) {
      results.push({
        type: "bearish",
        time: candle.time,
        index: i,
        level: (bodyTop + candle.high) / 2,
        zoneHigh: candle.high,
        zoneLow: bodyTop,
        wickSize: upperWickSize,
        ratio: upperWickRatio,
        candleHigh: candle.high,
        candleLow: candle.low,
        tier: 1,  // 占位,后面统一算
      });
    }

    // 下影 = 支撑候选(bullish action level:买入区)
    if (lowerWickRatio >= minWickRatio) {
      results.push({
        type: "bullish",
        time: candle.time,
        index: i,
        level: (candle.low + bodyBottom) / 2,
        zoneHigh: bodyBottom,
        zoneLow: candle.low,
        wickSize: lowerWickSize,
        ratio: lowerWickRatio,
        candleHigh: candle.high,
        candleLow: candle.low,
        tier: 1,  // 占位,后面统一算
      });
    }
  }

  // 算 tier:看上一个 wick 类型,同方向 +1,不同方向 reset 到 1
  for (let i = 0; i < results.length; i++) {
    if (i === 0) {
      results[i].tier = 1;
    } else if (results[i].type === results[i - 1].type) {
      // 同方向(都是 R 或都是 S)
      results[i].tier = results[i - 1].tier + 1;
    } else {
      // 切换方向(从 S 变 R 或 从 R 变 S)
      results[i].tier = 1;
    }
  }

  return results;
}

/**
 * 实时判断 wick 是否被"测试过"(后续某根 K 的 range 包住 level)
 * - 最后一根 K(进行中)也算作 tester → 当前 tick 一碰到老 level,该 zone 立刻失效
 * - 但最后一根不作为 wick 来源
 */
export function isWickTested(
  rejection: Rejection,
  candles: Candle[]
): boolean {
  for (let j = rejection.index + 1; j < candles.length; j++) {
    const c = candles[j];
    if (c.low <= rejection.level && c.high >= rejection.level) {
      return true;
    }
  }
  return false;
}
