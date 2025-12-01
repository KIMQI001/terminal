import { Candle } from "@/types/chart";
import { FVG } from "@/types/indicator";

/**
 * Detect Fair Value Gaps (FVG) in price data
 * FVG is created when there's a gap between candle 1's wick and candle 3's wick
 * that is not covered by candle 2's body
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
        // Check if FVG has been filled
        let filled = false;
        let fillPercentage = 0;

        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j].low <= candle1.high) {
            filled = true;
            fillPercentage = 100;
            break;
          }
          // Partial fill
          if (candles[j].low < candle3.low) {
            const filledAmount = candle3.low - candles[j].low;
            fillPercentage = Math.min(100, (filledAmount / gapSize) * 100);
          }
        }

        fvgs.push({
          type: "bullish",
          high: candle3.low,
          low: candle1.high,
          time: candle2.time,
          filled,
          fillPercentage,
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
          // Partial fill
          if (candles[j].high > candle3.high) {
            const filledAmount = candles[j].high - candle3.high;
            fillPercentage = Math.min(100, (filledAmount / gapSize) * 100);
          }
        }

        fvgs.push({
          type: "bearish",
          high: candle1.low,
          low: candle3.high,
          time: candle2.time,
          filled,
          fillPercentage,
        });
      }
    }
  }

  // Return only recent, unfilled FVGs
  return fvgs.filter((fvg) => !fvg.filled).slice(-15);
}
