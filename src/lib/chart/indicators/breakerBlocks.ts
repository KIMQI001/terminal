import { Candle } from "@/types/chart";
import { OrderBlock } from "@/types/indicator";

export interface BreakerBlock {
  type: "bullish" | "bearish"; // Opposite of original OB type
  high: number;
  low: number;
  startTime: number;
  endTime?: number;
  originalType: "bullish" | "bearish"; // What the OB was before it failed
  mitigated: boolean;
}

/**
 * Detect Breaker Blocks
 *
 * A Breaker Block is a failed Order Block:
 * - When a bullish OB is broken (price closes below), it becomes a bearish breaker
 * - When a bearish OB is broken (price closes above), it becomes a bullish breaker
 *
 * The breaker then acts as support/resistance in the opposite direction
 */
export function detectBreakerBlocks(
  candles: Candle[],
  orderBlocks: OrderBlock[],
  maxBreakers: number = 5
): BreakerBlock[] {
  const breakers: BreakerBlock[] = [];

  if (candles.length < 3 || orderBlocks.length === 0) return breakers;

  // Look for mitigated order blocks - these can become breakers
  const mitigatedOBs = orderBlocks.filter((ob) => ob.mitigated);

  for (const ob of mitigatedOBs) {
    // Find where the OB was broken
    const breakCandle = candles.find((c) => {
      if (c.time <= ob.startTime) return false;

      if (ob.type === "bullish") {
        // Bullish OB is broken when price closes below its low
        return c.close < ob.low;
      } else {
        // Bearish OB is broken when price closes above its high
        return c.close > ob.high;
      }
    });

    if (!breakCandle) continue;

    // Check if the breaker has been mitigated (price returns to it)
    const breakerMitigated = candles.some((c) => {
      if (c.time <= breakCandle.time) return false;

      if (ob.type === "bullish") {
        // Bullish OB became bearish breaker - mitigated when price returns to it from below
        return c.high >= ob.low && c.close < ob.high;
      } else {
        // Bearish OB became bullish breaker - mitigated when price returns to it from above
        return c.low <= ob.high && c.close > ob.low;
      }
    });

    breakers.push({
      type: ob.type === "bullish" ? "bearish" : "bullish",
      high: ob.high,
      low: ob.low,
      startTime: breakCandle.time,
      endTime: breakerMitigated ? candles[candles.length - 1].time : undefined,
      originalType: ob.type,
      mitigated: breakerMitigated,
    });

    if (breakers.length >= maxBreakers) break;
  }

  // Return only non-mitigated breakers (active)
  return breakers.filter((b) => !b.mitigated);
}
