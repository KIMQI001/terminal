import { Candle } from "@/types/chart";
import { OrderBlock } from "@/types/indicator";

/**
 * Detect Order Blocks based on LuxAlgo methodology
 *
 * 核心逻辑：
 * 1. 用 highest/lowest 检测 swing points
 * 2. 当价格突破 swing high 时，找 swing 到突破点之间的最低 K 线 = Bullish OB
 * 3. 当价格突破 swing low 时，找 swing 到突破点之间的最高 K 线 = Bearish OB
 * 4. OB 被反向突破时变成 breaker
 */
export function detectOrderBlocks(
  candles: Candle[],
  length: number = 10,
  showBull: number = 3,
  showBear: number = 3,
  useBody: boolean = false
): OrderBlock[] {
  if (candles.length < length + 10) return [];

  const getMax = (c: Candle) => useBody ? Math.max(c.close, c.open) : c.high;
  const getMin = (c: Candle) => useBody ? Math.min(c.close, c.open) : c.low;

  // Tracked swing structure
  interface Swing {
    price: number;
    index: number;
    time: number;
    crossed: boolean;
  }

  // OB tracking
  interface OBTrack {
    top: number;
    btm: number;
    loc: number;       // time
    locIndex: number;  // index for later reference
    breaker: boolean;
    breakLoc?: number;
  }

  const bullishOBs: OBTrack[] = [];
  const bearishOBs: OBTrack[] = [];

  let os = 0; // oscillator: 0 = down trend, 1 = up trend
  let topSwing: Swing | null = null;
  let btmSwing: Swing | null = null;

  // Process candles
  for (let i = length; i < candles.length; i++) {
    const candle = candles[i];
    const candleAtLen = candles[i - length]; // [length] bars ago

    // Calculate highest/lowest of past 'length' bars
    // LuxAlgo: upper = ta.highest(len), lower = ta.lowest(len)
    // This is the highest/lowest from (i-length) to (i-1), not including the [length] candle itself
    let upper = -Infinity;
    let lower = Infinity;
    for (let j = i - length + 1; j < i; j++) {
      upper = Math.max(upper, candles[j].high);
      lower = Math.min(lower, candles[j].low);
    }

    // Trend detection based on LuxAlgo logic
    const prevOs = os;
    if (candleAtLen.high > upper) {
      os = 0; // swing high detected, trend turning down
    } else if (candleAtLen.low < lower) {
      os = 1; // swing low detected, trend turning up
    }

    // Record new swing high
    if (os === 0 && prevOs !== 0) {
      topSwing = {
        price: candleAtLen.high,
        index: i - length,
        time: candleAtLen.time,
        crossed: false,
      };
    }

    // Record new swing low
    if (os === 1 && prevOs !== 1) {
      btmSwing = {
        price: candleAtLen.low,
        index: i - length,
        time: candleAtLen.time,
        crossed: false,
      };
    }

    // Check for bullish OB: price breaks above swing high
    if (topSwing && !topSwing.crossed && candle.close > topSwing.price) {
      topSwing.crossed = true;

      // Find the lowest candle between swing and current bar
      let minima = getMax(candles[i - 1]); // start with previous candle's max
      let maxima = getMin(candles[i - 1]);
      let loc = candles[i - 1].time;
      let locIndex = i - 1;

      for (let j = 1; j < i - topSwing.index; j++) {
        const idx = i - j;
        if (idx <= topSwing.index) break;

        const min = getMin(candles[idx]);
        if (min < minima) {
          minima = min;
          maxima = getMax(candles[idx]);
          loc = candles[idx].time;
          locIndex = idx;
        }
      }

      bullishOBs.unshift({
        top: maxima,
        btm: minima,
        loc,
        locIndex,
        breaker: false,
      });
    }

    // Check for bearish OB: price breaks below swing low
    if (btmSwing && !btmSwing.crossed && candle.close < btmSwing.price) {
      btmSwing.crossed = true;

      // Find the highest candle between swing and current bar
      let maxima = getMin(candles[i - 1]); // start with previous candle's min
      let minima = getMax(candles[i - 1]);
      let loc = candles[i - 1].time;
      let locIndex = i - 1;

      for (let j = 1; j < i - btmSwing.index; j++) {
        const idx = i - j;
        if (idx <= btmSwing.index) break;

        const max = getMax(candles[idx]);
        if (max > maxima) {
          maxima = max;
          minima = getMin(candles[idx]);
          loc = candles[idx].time;
          locIndex = idx;
        }
      }

      bearishOBs.unshift({
        top: maxima,
        btm: minima,
        loc,
        locIndex,
        breaker: false,
      });
    }

    // Check bullish OBs for mitigation/breaker
    for (let j = bullishOBs.length - 1; j >= 0; j--) {
      const ob = bullishOBs[j];
      if (!ob.breaker) {
        // Bullish OB breaks when price closes below its bottom
        if (Math.min(candle.close, candle.open) < ob.btm) {
          ob.breaker = true;
          ob.breakLoc = candle.time;
        }
      } else {
        // Breaker removed when price closes above its top
        if (candle.close > ob.top) {
          bullishOBs.splice(j, 1);
        }
      }
    }

    // Check bearish OBs for mitigation/breaker
    for (let j = bearishOBs.length - 1; j >= 0; j--) {
      const ob = bearishOBs[j];
      if (!ob.breaker) {
        // Bearish OB breaks when price closes above its top
        if (Math.max(candle.close, candle.open) > ob.top) {
          ob.breaker = true;
          ob.breakLoc = candle.time;
        }
      } else {
        // Breaker removed when price closes below its bottom
        if (candle.close < ob.btm) {
          bearishOBs.splice(j, 1);
        }
      }
    }
  }

  // Convert to OrderBlock format
  const result: OrderBlock[] = [];

  // Add bullish OBs (non-breakers only, limited count)
  const activeBullish = bullishOBs.filter(ob => !ob.breaker).slice(0, showBull);
  for (const ob of activeBullish) {
    result.push({
      type: "bullish",
      high: ob.top,
      low: ob.btm,
      startTime: ob.loc,
      mitigated: false,
      strength: 0,
    });
  }

  // Add bearish OBs (non-breakers only, limited count)
  const activeBearish = bearishOBs.filter(ob => !ob.breaker).slice(0, showBear);
  for (const ob of activeBearish) {
    result.push({
      type: "bearish",
      high: ob.top,
      low: ob.btm,
      startTime: ob.loc,
      mitigated: false,
      strength: 0,
    });
  }

  return result;
}
