/**
 * FVG (Fair Value Gap) 检测（前端算法移植）
 * 对应前端 src/lib/chart/indicators/fvg.ts
 * 默认 minGapPercent=0.1, fillPercentage < 80, 取最近 15 条
 */

import { Candle, FVG } from './ictBlocks15m.types';

/**
 * 检测 FVG
 * - 看涨 FVG: candle3.low > candle1.high
 * - 看跌 FVG: candle3.high < candle1.low
 * - 入场点 fib22: 看涨 = high - size*0.22; 看跌 = low + size*0.22
 * - 填充度追踪：用 wick 极值计算最大填充深度
 */
export function detectFVGs(
  candles: Candle[],
  minGapPercent: number = 0.1
): FVG[] {
  const fvgs: FVG[] = [];

  for (let i = 2; i < candles.length; i++) {
    const candle1 = candles[i - 2];
    const candle2 = candles[i - 1];
    const candle3 = candles[i];

    // Bullish FVG: Gap between candle1 high and candle3 low
    if (candle3.low > candle1.high) {
      const gapSize = candle3.low - candle1.high;
      const gapPercent = (gapSize / candle1.high) * 100;

      if (gapPercent >= minGapPercent) {
        const fvgHigh = candle3.low;
        const fvgLow = candle1.high;
        const fvgSize = fvgHigh - fvgLow;
        const fib22 = fvgHigh - fvgSize * 0.22;

        // 计算填充度
        let filled = false;
        let fillPercentage = 0;

        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j].low <= candle1.high) {
            filled = true;
            fillPercentage = 100;
            break;
          }
          // 部分填充 - 追踪最大深度（影线触及也算）
          if (candles[j].low <= candle3.low) {
            const filledAmount = candle3.low - candles[j].low;
            const currentFill = Math.min(100, (filledAmount / gapSize) * 100);
            fillPercentage = Math.max(fillPercentage, currentFill);
          }
        }

        fvgs.push({
          type: 'bullish',
          high: fvgHigh,
          low: fvgLow,
          time: candle2.time,
          filled,
          fillPercentage,
          fib22,
        });
      }
    }

    // Bearish FVG
    if (candle3.high < candle1.low) {
      const gapSize = candle1.low - candle3.high;
      const gapPercent = (gapSize / candle1.low) * 100;

      if (gapPercent >= minGapPercent) {
        const fvgHigh = candle1.low;
        const fvgLow = candle3.high;
        const fvgSize = fvgHigh - fvgLow;
        const fib22 = fvgLow + fvgSize * 0.22;

        let filled = false;
        let fillPercentage = 0;

        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j].high >= candle1.low) {
            filled = true;
            fillPercentage = 100;
            break;
          }
          if (candles[j].high >= candle3.high) {
            const filledAmount = candles[j].high - candle3.high;
            const currentFill = Math.min(100, (filledAmount / gapSize) * 100);
            fillPercentage = Math.max(fillPercentage, currentFill);
          }
        }

        fvgs.push({
          type: 'bearish',
          high: fvgHigh,
          low: fvgLow,
          time: candle2.time,
          filled,
          fillPercentage,
          fib22,
        });
      }
    }
  }

  // 仅返回填充度 < 80% 的最近 15 条
  return fvgs.filter(fvg => fvg.fillPercentage < 80).slice(-15);
}
