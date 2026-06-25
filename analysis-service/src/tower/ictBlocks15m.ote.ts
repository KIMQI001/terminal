/**
 * OTE (Optimal Trade Entry) 区域检测（前端算法移植）
 * 对应前端 src/lib/chart/indicators/ote.ts
 * 默认 maxZones=3
 *
 * 关键算法：
 * - Bullish OTE: swingHigh 之后找 swingLow，fib618 = high - range*0.618, fib786 = high - range*0.786, fib675 = high - range*0.675
 * - Bearish OTE: swingLow 之后找 swingHigh, 反向
 * - historicallyFilled 过滤：startTime 后任何 K 线 low <= fib786（bull）/ high >= fib786（bear）则丢弃
 * - fillPercent > 80 过滤
 * - 只保留同向区域（bull: fib786 > currentPrice; bear: fib618 < currentPrice）
 */

import { Candle, SwingPoint, OTEZone } from './ictBlocks15m.types';

export function detectOTEZones(
  swingPoints: SwingPoint[],
  currentPrice: number,
  candles: Candle[] = [],
  maxZones: number = 3
): OTEZone[] {
  const zones: OTEZone[] = [];

  if (swingPoints.length < 2) return zones;

  // 按时间倒序排列（最新的在前）
  const sorted = [...swingPoints].sort((a, b) => b.time - a.time);

  for (let i = 0; i < sorted.length - 1 && zones.length < maxZones; i++) {
    const current = sorted[i];
    const prev = sorted[i + 1];

    // Bullish OTE: high 之后找 low（回撤后做多）
    if (current.type === 'high' && prev.type === 'low') {
      const swingHigh = current.price;
      const swingLow = prev.price;
      const range = swingHigh - swingLow;

      if (range <= 0) continue;

      const fib618 = swingHigh - range * 0.618;
      const fib786 = swingHigh - range * 0.786;
      const fib675 = swingHigh - range * 0.675;

      // 检查历史 K 线是否已经完全穿过区域
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
        type: 'bullish',
        startTime: current.time,
        swingHigh,
        swingLow,
        fib618,
        fib786,
        fib675,
        active,
      });
    }

    // Bearish OTE: low 之后找 high（反弹后做空）
    if (current.type === 'low' && prev.type === 'high') {
      const swingHigh = prev.price;
      const swingLow = current.price;
      const range = swingHigh - swingLow;

      if (range <= 0) continue;

      const fib618 = swingLow + range * 0.618;
      const fib786 = swingLow + range * 0.786;
      const fib675 = swingLow + range * 0.675;

      const startTime = current.time;
      let historicallyFilled = false;
      for (const candle of candles) {
        if (candle.time > startTime && candle.high >= fib786) {
          historicallyFilled = true;
          break;
        }
      }
      if (historicallyFilled) continue;

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
        type: 'bearish',
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
