import { Candle } from "@/types/chart";
import { OrderBlock } from "@/types/indicator";

/**
 * Detect Order Blocks (OB) in price data
 * Bullish OB: Last down candle before a significant up move
 * Bearish OB: Last up candle before a significant down move
 */
export function detectOrderBlocks(
  candles: Candle[],
  minMovePercent: number = 0.5
): OrderBlock[] {
  const orderBlocks: OrderBlock[] = [];

  for (let i = 2; i < candles.length - 1; i++) {
    const prevCandle = candles[i - 1];
    const currentCandle = candles[i];
    const nextCandle = candles[i + 1];

    // Check for Bullish Order Block
    // Previous candle is bearish (close < open)
    // Current candle is strongly bullish and breaks above previous high
    const isPrevBearish = prevCandle.close < prevCandle.open;
    const isCurrBullish = currentCandle.close > currentCandle.open;
    const bullishMove =
      ((currentCandle.close - prevCandle.low) / prevCandle.low) * 100;

    if (isPrevBearish && isCurrBullish && bullishMove >= minMovePercent) {
      // Check if this OB gets mitigated (price returns to zone)
      let mitigated = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].low <= prevCandle.high) {
          mitigated = true;
          break;
        }
      }

      orderBlocks.push({
        type: "bullish",
        high: prevCandle.high,
        low: prevCandle.low,
        startTime: prevCandle.time,
        endTime: mitigated ? undefined : candles[candles.length - 1].time,
        mitigated,
        strength: bullishMove,
      });
    }

    // Check for Bearish Order Block
    // Previous candle is bullish (close > open)
    // Current candle is strongly bearish and breaks below previous low
    const isPrevBullish = prevCandle.close > prevCandle.open;
    const isCurrBearish = currentCandle.close < currentCandle.open;
    const bearishMove =
      ((prevCandle.high - currentCandle.close) / prevCandle.high) * 100;

    if (isPrevBullish && isCurrBearish && bearishMove >= minMovePercent) {
      // Check if this OB gets mitigated (price returns to zone)
      let mitigated = false;
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].high >= prevCandle.low) {
          mitigated = true;
          break;
        }
      }

      orderBlocks.push({
        type: "bearish",
        high: prevCandle.high,
        low: prevCandle.low,
        startTime: prevCandle.time,
        endTime: mitigated ? undefined : candles[candles.length - 1].time,
        mitigated,
        strength: bearishMove,
      });
    }
  }

  // Return only the most recent, non-mitigated order blocks
  return orderBlocks
    .filter((ob) => !ob.mitigated)
    .slice(-10);
}
