import { Candle, SwingPoint } from "@/types/chart";

/**
 * Detect swing highs and lows in price data
 * A swing high is a high that is higher than the highs on both sides
 * A swing low is a low that is lower than the lows on both sides
 */
export function detectSwingPoints(
  candles: Candle[],
  lookback: number = 3
): SwingPoint[] {
  const swingPoints: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];

    // Check for swing high
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (
        candles[i - j].high >= current.high ||
        candles[i + j].high >= current.high
      ) {
        isSwingHigh = false;
        break;
      }
    }

    if (isSwingHigh) {
      swingPoints.push({
        type: "high",
        price: current.high,
        time: current.time,
        index: i,
      });
    }

    // Check for swing low
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (
        candles[i - j].low <= current.low ||
        candles[i + j].low <= current.low
      ) {
        isSwingLow = false;
        break;
      }
    }

    if (isSwingLow) {
      swingPoints.push({
        type: "low",
        price: current.low,
        time: current.time,
        index: i,
      });
    }
  }

  return swingPoints.sort((a, b) => a.time - b.time);
}
