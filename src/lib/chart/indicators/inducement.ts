import { Candle, SwingPoint } from "@/types/chart";

export interface Inducement {
  type: "bullish" | "bearish";
  level: number;
  time: number;
  triggered: boolean; // Whether the inducement has been triggered (stop hunt occurred)
  triggeredTime?: number;
}

/**
 * Detect Inducements
 *
 * Inducements are small liquidity pools designed to trap retail traders:
 * - Minor swing highs/lows that get taken out before the real move
 * - Often found just above/below recent swing points
 *
 * These are smaller-scale versions of liquidity hunts
 */
export function detectInducements(
  candles: Candle[],
  swingPoints: SwingPoint[],
  maxInducements: number = 5
): Inducement[] {
  const inducements: Inducement[] = [];

  if (candles.length < 10 || swingPoints.length < 3) return inducements;

  // Find minor swing points (potential inducements)
  // These are swings with smaller lookback that get swept quickly
  const minorSwings = findMinorSwings(candles, 1); // Very short-term swings

  // Filter to find inducements - swings that got taken out quickly
  for (const swing of minorSwings) {
    // Check if this minor swing was taken out within 3-10 candles
    const followingCandles = candles.filter((c) => c.time > swing.time);

    if (followingCandles.length < 3) continue;

    // For bearish inducement: minor high that gets swept then rejected
    if (swing.type === "high") {
      const swept = followingCandles.slice(0, 10).find((c) => c.high > swing.price);

      if (swept) {
        // Check if price rejected after the sweep (came back down)
        const afterSweep = followingCandles.filter((c) => c.time > swept.time).slice(0, 5);
        const rejected = afterSweep.some((c) => c.close < swing.price);

        if (rejected) {
          inducements.push({
            type: "bearish",
            level: swing.price,
            time: swing.time,
            triggered: true,
            triggeredTime: swept.time,
          });
        }
      } else {
        // Not yet triggered
        inducements.push({
          type: "bearish",
          level: swing.price,
          time: swing.time,
          triggered: false,
        });
      }
    }

    // For bullish inducement: minor low that gets swept then rejected
    if (swing.type === "low") {
      const swept = followingCandles.slice(0, 10).find((c) => c.low < swing.price);

      if (swept) {
        // Check if price rejected after the sweep (came back up)
        const afterSweep = followingCandles.filter((c) => c.time > swept.time).slice(0, 5);
        const rejected = afterSweep.some((c) => c.close > swing.price);

        if (rejected) {
          inducements.push({
            type: "bullish",
            level: swing.price,
            time: swing.time,
            triggered: true,
            triggeredTime: swept.time,
          });
        }
      } else {
        // Not yet triggered
        inducements.push({
          type: "bullish",
          level: swing.price,
          time: swing.time,
          triggered: false,
        });
      }
    }

    if (inducements.length >= maxInducements) break;
  }

  return inducements;
}

/**
 * Find minor swings with very short lookback (potential inducements)
 */
function findMinorSwings(candles: Candle[], lookback: number = 1): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];

    // Check for swing high
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (
        candles[i - j].high >= current.high ||
        candles[i + j].high >= current.high
      ) {
        isHigh = false;
        break;
      }
    }

    if (isHigh) {
      swings.push({
        type: "high",
        price: current.high,
        time: current.time,
        index: i,
      });
    }

    // Check for swing low
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (
        candles[i - j].low <= current.low ||
        candles[i + j].low <= current.low
      ) {
        isLow = false;
        break;
      }
    }

    if (isLow) {
      swings.push({
        type: "low",
        price: current.low,
        time: current.time,
        index: i,
      });
    }
  }

  // Return only recent minor swings
  return swings.slice(-20);
}
