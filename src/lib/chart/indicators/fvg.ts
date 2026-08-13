import { Candle } from "@/types/chart";
import { FVG } from "@/types/indicator";

/**
 * Detect Fair Value Gaps (FVG) in price data
 * FVG is created when there's a gap between candle 1's wick and candle 3's wick
 * that is not covered by candle 2's body
 */
export function detectFVGs(
  candles: Candle[],
  minGapPercent: number = 0.01
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
        // Check if FVG has been filled
        let filled = false;
        let fillPercentage = 0;

        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j].low <= candle1.high) {
            filled = true;
            fillPercentage = 100;
            break;
          }
          // Partial fill - 追踪最大填充深度（影线触及也算）
          if (candles[j].low <= candle3.low) {
            const filledAmount = candle3.low - candles[j].low;
            const currentFill = Math.min(100, (filledAmount / gapSize) * 100);
            fillPercentage = Math.max(fillPercentage, currentFill);
          }
        }

        const fvgHigh = candle3.low;
        const fvgLow = candle1.high;
        const fvgSize = fvgHigh - fvgLow;
        // 看涨FVG：入场点在高位 - 22%（价格回调到FVG上部买入）
        const fib22 = fvgHigh - fvgSize * 0.22;

        fvgs.push({
          type: "bullish",
          high: fvgHigh,
          low: fvgLow,
          time: candle2.time,
          filled,
          fillPercentage,
          fib22,
          tier: 1,  // 占位,后面统一算
        });
      }
    }

    // Bearish FVG: Gap between candle1 low and candle3 high
    if (candle3.high < candle1.low) {
      const gapSize = candle1.low - candle3.high;
      const gapPercent = (gapSize / candle1.low) * 100;

      if (gapPercent >= minGapPercent) {
        // Check if FVG has been filled
        let filled = false;
        let fillPercentage = 0;

        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j].high >= candle1.low) {
            filled = true;
            fillPercentage = 100;
            break;
          }
          // Partial fill - 追踪最大填充深度（影线触及也算）
          if (candles[j].high >= candle3.high) {
            const filledAmount = candles[j].high - candle3.high;
            const currentFill = Math.min(100, (filledAmount / gapSize) * 100);
            fillPercentage = Math.max(fillPercentage, currentFill);
          }
        }

        const fvgHigh = candle1.low;
        const fvgLow = candle3.high;
        const fvgSize = fvgHigh - fvgLow;
        // 看跌FVG：入场点在低位 + 22%（价格回调到FVG下部卖出）
        const fib22 = fvgLow + fvgSize * 0.22;

        fvgs.push({
          type: "bearish",
          high: fvgHigh,
          low: fvgLow,
          time: candle2.time,
          filled,
          fillPercentage,
          fib22,
          tier: 1,  // 占位,后面统一算
        });
      }
    }
  }

  // Return only recent FVGs with fill < 80%
  const live = fvgs.filter((fvg) => fvg.fillPercentage < 80).slice(-15);

  // 算 tier:看上一个未填充的同方向 FVG,同方向 +1,切换 reset 到 1
  for (let i = 0; i < live.length; i++) {
    if (i === 0) {
      live[i].tier = 1;
      continue;
    }
    let prevIdx = i - 1;
    while (prevIdx >= 0) {
      const prev = live[prevIdx];
      // 跳过不同方向(只是切换参考点,不算同方向连续)
      // 这里允许跨方向(把每个 FVG 的"上一个"当作切换参考)
      if (prev.type === live[i].type) {
        live[i].tier = prev.tier + 1;
        break;
      } else {
        live[i].tier = 1;
        break;
      }
    }
    if (prevIdx < 0) live[i].tier = 1;
  }

  return live;
}
