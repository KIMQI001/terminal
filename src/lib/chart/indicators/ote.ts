import { SwingPoint, Candle } from "@/types/chart";

export interface OTEZone {
  type: "bullish" | "bearish";
  startTime: number;
  swingHigh: number;
  swingLow: number;
  fib618: number;  // 0.618 level
  fib786: number;  // 0.786 level (optimal entry)
  fib675: number;  // 0.675 level (sweet spot)
  active: boolean; // Whether the zone is still valid
}

/**
 * Detect OTE (Optimal Trade Entry) Zones
 *
 * OTE is the 0.618-0.786 Fibonacci retracement zone:
 * - Bullish OTE: After a swing low, price retraces into 61.8%-78.6% of the move
 * - Bearish OTE: After a swing high, price retraces into 61.8%-78.6% of the move
 */
export function detectOTEZones(
  swingPoints: SwingPoint[],
  currentPrice: number,
  candles: Candle[] = [],
  maxZones: number = 3
): OTEZone[] {
  const zones: OTEZone[] = [];

  if (swingPoints.length < 2) return zones;

  // Sort by time
  const sorted = [...swingPoints].sort((a, b) => b.time - a.time);

  // Look for recent swing patterns
  for (let i = 0; i < sorted.length - 1 && zones.length < maxZones; i++) {
    const current = sorted[i];
    const prev = sorted[i + 1];

    // Bullish OTE: After a Higher High, look for retracement to the prior Low
    // 只在当前价格下方显示（买入机会）
    if (current.type === "high" && prev.type === "low") {
      const swingHigh = current.price;
      const swingLow = prev.price;
      const range = swingHigh - swingLow;

      if (range <= 0) continue;

      // Calculate Fibonacci levels from high to low (fib618 > fib786)
      const fib618 = swingHigh - range * 0.618;
      const fib786 = swingHigh - range * 0.786;
      const fib675 = swingHigh - range * 0.675;

      // 检查历史 K 线是否已经完全穿过区域（low <= fib786）
      const startTime = current.time;
      let historicallyFilled = false;
      for (const candle of candles) {
        if (candle.time > startTime && candle.low <= fib786) {
          historicallyFilled = true;
          break;
        }
      }
      if (historicallyFilled) continue;

      // 计算当前填充百分比
      const zoneHeight = fib618 - fib786;
      let fillPercent = 0;

      if (currentPrice >= fib618) {
        fillPercent = 0;
      } else if (currentPrice <= fib786) {
        fillPercent = 100;
      } else {
        fillPercent = ((fib618 - currentPrice) / zoneHeight) * 100;
      }

      if (fillPercent > 80) continue;

      // 只有当区域在当前价格下方时才显示
      if (fib786 > currentPrice) continue;

      const active = currentPrice >= fib786 && currentPrice <= fib618;

      zones.push({
        type: "bullish",
        startTime: current.time,  // 从 pivot high 开始绘制
        swingHigh,
        swingLow,
        fib618,
        fib786,
        fib675,
        active,
      });
    }

    // Bearish OTE: After a Lower Low, look for retracement to the prior High
    // 只在当前价格上方显示（卖出机会）
    if (current.type === "low" && prev.type === "high") {
      const swingHigh = prev.price;
      const swingLow = current.price;
      const range = swingHigh - swingLow;

      if (range <= 0) continue;

      // Calculate Fibonacci levels from low to high (fib786 > fib618)
      const fib618 = swingLow + range * 0.618;
      const fib786 = swingLow + range * 0.786;
      const fib675 = swingLow + range * 0.675;

      // 检查历史 K 线是否已经完全穿过区域（high >= fib786）
      const startTime = current.time;
      let historicallyFilled = false;
      for (const candle of candles) {
        if (candle.time > startTime && candle.high >= fib786) {
          historicallyFilled = true;
          break;
        }
      }
      if (historicallyFilled) continue;

      // 计算当前填充百分比
      const zoneHeight = fib786 - fib618;
      let fillPercent = 0;

      if (currentPrice <= fib618) {
        fillPercent = 0;
      } else if (currentPrice >= fib786) {
        fillPercent = 100;
      } else {
        fillPercent = ((currentPrice - fib618) / zoneHeight) * 100;
      }

      if (fillPercent > 80) continue;

      // 只有当区域在当前价格上方时才显示
      if (fib618 < currentPrice) continue;

      const active = currentPrice >= fib618 && currentPrice <= fib786;

      zones.push({
        type: "bearish",
        startTime: current.time,
        swingHigh,
        swingLow,
        fib618,
        fib786,
        fib675,
        active,
      });
    }
  }

  return zones;
}
