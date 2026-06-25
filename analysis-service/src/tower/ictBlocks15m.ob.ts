/**
 * Order Block 检测（LuxAlgo 方法，前端算法移植）
 * 对应前端 src/lib/chart/indicators/orderBlocks.ts
 * 默认 length=10, showBull=3, showBear=3, useBody=false
 */

import { Candle, OrderBlock } from './ictBlocks15m.types';

interface Swing {
  price: number;
  index: number;
  time: number;
  crossed: boolean;
}

interface OBTrack {
  top: number;
  btm: number;
  loc: number;
  locIndex: number;
  breaker: boolean;
}

/**
 * 检测 Order Blocks
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

  const bullishOBs: OBTrack[] = [];
  const bearishOBs: OBTrack[] = [];

  let os = 0; // 趋势: 0=down, 1=up
  let topSwing: Swing | null = null;
  let btmSwing: Swing | null = null;

  for (let i = length; i < candles.length; i++) {
    const candle = candles[i];
    const candleAtLen = candles[i - length];

    // 计算 (i-length, i) 窗口内的最高/最低
    let upper = -Infinity;
    let lower = Infinity;
    for (let j = i - length + 1; j < i; j++) {
      upper = Math.max(upper, candles[j].high);
      lower = Math.min(lower, candles[j].low);
    }

    // 趋势检测
    const prevOs = os;
    if (candleAtLen.high > upper) {
      os = 0; // swing high detected
    } else if (candleAtLen.low < lower) {
      os = 1; // swing low detected
    }

    if (os === 0 && prevOs !== 0) {
      topSwing = {
        price: candleAtLen.high,
        index: i - length,
        time: candleAtLen.time,
        crossed: false,
      };
    }

    if (os === 1 && prevOs !== 1) {
      btmSwing = {
        price: candleAtLen.low,
        index: i - length,
        time: candleAtLen.time,
        crossed: false,
      };
    }

    // Bullish OB: price breaks above swing high
    if (topSwing && !topSwing.crossed && candle.close > topSwing.price) {
      topSwing.crossed = true;

      let minima = getMax(candles[i - 1]);
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

    // Bearish OB: price breaks below swing low
    if (btmSwing && !btmSwing.crossed && candle.close < btmSwing.price) {
      btmSwing.crossed = true;

      let maxima = getMin(candles[i - 1]);
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

    // Mitigation / Breaker 检测
    for (let j = bullishOBs.length - 1; j >= 0; j--) {
      const ob = bullishOBs[j];
      if (!ob.breaker) {
        if (Math.min(candle.close, candle.open) < ob.btm) {
          ob.breaker = true;
        }
      } else {
        if (candle.close > ob.top) {
          bullishOBs.splice(j, 1);
        }
      }
    }

    for (let j = bearishOBs.length - 1; j >= 0; j--) {
      const ob = bearishOBs[j];
      if (!ob.breaker) {
        if (Math.max(candle.close, candle.open) > ob.top) {
          ob.breaker = true;
        }
      } else {
        if (candle.close < ob.btm) {
          bearishOBs.splice(j, 1);
        }
      }
    }
  }

  // 用历史极值计算填充度
  const calculateFillPercentage = (
    obTop: number,
    obBtm: number,
    locIndex: number,
    type: 'bullish' | 'bearish'
  ): number => {
    let fillPercentage = 0;
    const obSize = obTop - obBtm;
    if (obSize <= 0) return 0;

    for (let j = locIndex + 1; j < candles.length; j++) {
      if (type === 'bullish') {
        if (candles[j].low <= obBtm) return 100;
        if (candles[j].low <= obTop) {
          const filled = ((obTop - candles[j].low) / obSize) * 100;
          fillPercentage = Math.max(fillPercentage, Math.min(100, filled));
        }
      } else {
        if (candles[j].high >= obTop) return 100;
        if (candles[j].high >= obBtm) {
          const filled = ((candles[j].high - obBtm) / obSize) * 100;
          fillPercentage = Math.max(fillPercentage, Math.min(100, filled));
        }
      }
    }
    return fillPercentage;
  };

  const result: OrderBlock[] = [];

  const activeBullish = bullishOBs.filter(ob => !ob.breaker).slice(0, showBull);
  for (const ob of activeBullish) {
    const obSize = ob.top - ob.btm;
    const fillPercentage = calculateFillPercentage(ob.top, ob.btm, ob.locIndex, 'bullish');
    const fib22 = ob.top - obSize * 0.22;
    result.push({
      type: 'bullish',
      high: ob.top,
      low: ob.btm,
      startTime: ob.loc,
      mitigated: false,
      fillPercentage,
      fib22,
    });
  }

  const activeBearish = bearishOBs.filter(ob => !ob.breaker).slice(0, showBear);
  for (const ob of activeBearish) {
    const obSize = ob.top - ob.btm;
    const fillPercentage = calculateFillPercentage(ob.top, ob.btm, ob.locIndex, 'bearish');
    const fib22 = ob.btm + obSize * 0.22;
    result.push({
      type: 'bearish',
      high: ob.top,
      low: ob.btm,
      startTime: ob.loc,
      mitigated: false,
      fillPercentage,
      fib22,
    });
  }

  return result;
}
