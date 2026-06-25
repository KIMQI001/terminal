/**
 * Swing Points 检测（前端算法移植）
 * 对应前端 src/lib/chart/indicators/swingPoints.ts::detectAllPivots
 * 默认 leftBars=2, rightBars=2, minSwingPercent=0.5
 */

import { Candle, SwingPoint } from './ictBlocks15m.types';

/**
 * 检测局部极值点（不过滤，不过分组）
 * 左侧 leftBars 根、右侧 rightBars 根都未超过当前 high/low 才算极值
 */
export function detectAllPivots(
  candles: Candle[],
  leftBars: number = 2,
  rightBars: number = 2
): SwingPoint[] {
  const pivots: SwingPoint[] = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const current = candles[i];

    // Pivot High: 左侧 leftBars 根的 high 都 < current.high
    let isPivotHigh = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].high >= current.high) {
        isPivotHigh = false;
        break;
      }
    }
    // 右侧 rightBars 根的 high 都 < current.high
    if (isPivotHigh) {
      for (let j = 1; j <= rightBars; j++) {
        if (candles[i + j].high > current.high) {
          isPivotHigh = false;
          break;
        }
      }
    }
    if (isPivotHigh) {
      pivots.push({
        type: 'high',
        price: current.high,
        time: current.time,
        index: i,
      });
    }

    // Pivot Low
    let isPivotLow = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].low <= current.low) {
        isPivotLow = false;
        break;
      }
    }
    if (isPivotLow) {
      for (let j = 1; j <= rightBars; j++) {
        if (candles[i + j].low < current.low) {
          isPivotLow = false;
          break;
        }
      }
    }
    if (isPivotLow) {
      pivots.push({
        type: 'low',
        price: current.low,
        time: current.time,
        index: i,
      });
    }
  }

  return pivots;
}

/**
 * 按摆动幅度过滤（前端 filterBySwingPercent 移植）
 * 同类型相邻 pivot 价格变化 >= minSwingPercent 才保留
 */
export function filterBySwingPercent(
  pivots: SwingPoint[],
  minSwingPercent: number = 0.5
): SwingPoint[] {
  const result: SwingPoint[] = [];
  let lastHighPrice = 0;
  let lastLowPrice = Infinity;

  for (const pivot of pivots) {
    if (pivot.type === 'high') {
      if (lastHighPrice === 0) {
        result.push(pivot);
      } else {
        const change = Math.abs(pivot.price - lastHighPrice) / lastHighPrice * 100;
        if (change >= minSwingPercent) {
          result.push(pivot);
        }
      }
      lastHighPrice = pivot.price;
    } else {
      if (lastLowPrice === Infinity) {
        result.push(pivot);
      } else {
        const change = Math.abs(pivot.price - lastLowPrice) / lastLowPrice * 100;
        if (change >= minSwingPercent) {
          result.push(pivot);
        }
      }
      lastLowPrice = pivot.price;
    }
  }

  return result;
}

/**
 * 一站式：检测并过滤 swing points
 */
export function detectSwings(
  candles: Candle[],
  leftBars: number = 2,
  rightBars: number = 2,
  minSwingPercent: number = 0.5
): SwingPoint[] {
  const pivots = detectAllPivots(candles, leftBars, rightBars);
  return filterBySwingPercent(pivots, minSwingPercent);
}
