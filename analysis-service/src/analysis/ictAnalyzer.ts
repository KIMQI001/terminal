/**
 * ICT 指标分析器
 * 复用前端的 ICT 指标计算逻辑
 */

import { Candle, Timeframe } from '../data/klineClient';

// ============================================
// 类型定义
// ============================================

export interface SwingPoint {
  type: 'high' | 'low';
  price: number;
  time: number;
  index: number;
}

export interface OrderBlock {
  type: 'bullish' | 'bearish';
  high: number;
  low: number;
  startTime: number;
  mitigated: boolean;
  strength: number;
  fillPercentage: number;  // 最大填充深度 (0-100)
  fib22: number;           // 0.22 入场点
}

export interface FVG {
  type: 'bullish' | 'bearish';
  high: number;
  low: number;
  time: number;
  filled: boolean;
  fillPercentage: number;
  fib22: number;
  entry: number;      // 入场点 = 0.22 位置
  stopLoss: number;   // 止损 = 边界
}

export interface OTEZone {
  type: 'bullish' | 'bearish';
  startTime: number;
  swingHigh: number;
  swingLow: number;
  fib618: number;
  fib786: number;
  fib675: number;
  active: boolean;
  entry: number;      // 入场点 = 0.675 位置
  stopLoss: number;   // 止损 = 略过 0.786
}

export interface BOS {
  type: 'bullish' | 'bearish';
  level: number;
  time: number;
}

export interface CHoCH {
  type: 'bullish' | 'bearish';
  level: number;
  time: number;
  previousTrend: 'up' | 'down';
}

export interface LiquidityZone {
  type: 'buy-side' | 'sell-side';
  level: number;
  strength: number;
  swept: boolean;
}

export interface ICTAnalysisResult {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  currentPrice: number;

  // 核心指标
  swingPoints: SwingPoint[];
  orderBlocks: OrderBlock[];
  fvgs: FVG[];
  oteZones: OTEZone[];
  bos: BOS[];
  choch: CHoCH[];
  liquidityZones: LiquidityZone[];

  // 综合判断
  trend: 'bullish' | 'bearish' | 'neutral';
  keyLevels: { level: number; type: string; strength: number }[];
}

// ============================================
// Swing Points 检测
// ============================================

export function detectSwingPoints(
  candles: Candle[],
  leftBars: number = 3,
  rightBars: number = 3,
  minSwingPercent: number = 1.5
): SwingPoint[] {
  if (candles.length < leftBars + 1) return [];

  const rawSwings: SwingPoint[] = [];

  for (let i = leftBars; i < candles.length; i++) {
    const current = candles[i];
    const actualRightBars = Math.min(rightBars, candles.length - 1 - i);

    // 检查 Pivot High
    let isPivotHigh = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].high >= current.high) {
        isPivotHigh = false;
        break;
      }
    }
    if (isPivotHigh && actualRightBars > 0) {
      for (let j = 1; j <= actualRightBars; j++) {
        if (candles[i + j].high > current.high) {
          isPivotHigh = false;
          break;
        }
      }
    }

    if (isPivotHigh) {
      rawSwings.push({
        type: 'high',
        price: current.high,
        time: current.time,
        index: i,
      });
    }

    // 检查 Pivot Low
    let isPivotLow = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].low <= current.low) {
        isPivotLow = false;
        break;
      }
    }
    if (isPivotLow && actualRightBars > 0) {
      for (let j = 1; j <= actualRightBars; j++) {
        if (candles[i + j].low < current.low) {
          isPivotLow = false;
          break;
        }
      }
    }

    if (isPivotLow) {
      rawSwings.push({
        type: 'low',
        price: current.low,
        time: current.time,
        index: i,
      });
    }
  }

  rawSwings.sort((a, b) => a.time - b.time);
  if (rawSwings.length === 0) return [];

  // 构建交替结构
  const result: SwingPoint[] = [];
  let currentGroup: SwingPoint[] = [rawSwings[0]];

  for (let i = 1; i < rawSwings.length; i++) {
    const swing = rawSwings[i];
    const lastInGroup = currentGroup[currentGroup.length - 1];

    if (swing.type === lastInGroup.type) {
      currentGroup.push(swing);
    } else {
      const best = selectBestFromGroup(currentGroup);
      const lastConfirmed = result[result.length - 1];
      if (lastConfirmed) {
        const priceChange =
          (Math.abs(best.price - lastConfirmed.price) / lastConfirmed.price) * 100;
        if (priceChange >= minSwingPercent) {
          result.push(best);
        }
      } else {
        result.push(best);
      }
      currentGroup = [swing];
    }
  }

  // 处理最后一组
  if (currentGroup.length > 0) {
    const best = selectBestFromGroup(currentGroup);
    const lastConfirmed = result[result.length - 1];
    if (lastConfirmed) {
      const priceChange =
        (Math.abs(best.price - lastConfirmed.price) / lastConfirmed.price) * 100;
      if (priceChange >= minSwingPercent) {
        result.push(best);
      }
    } else {
      result.push(best);
    }
  }

  return result;
}

function selectBestFromGroup(group: SwingPoint[]): SwingPoint {
  if (group.length === 1) return group[0];
  const isHigh = group[0].type === 'high';
  return group.reduce((best, current) => {
    if (isHigh) {
      return current.price > best.price ? current : best;
    } else {
      return current.price < best.price ? current : best;
    }
  });
}

// ============================================
// FVG 检测
// ============================================

export function detectFVGs(candles: Candle[], minGapPercent: number = 0.1): FVG[] {
  const fvgs: FVG[] = [];
  if (candles.length < 3) return fvgs;

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    // Bullish FVG: c3.low > c1.high
    if (c3.low > c1.high) {
      const gapSize = c3.low - c1.high;
      const gapPercent = (gapSize / c2.close) * 100;
      if (gapPercent >= minGapPercent) {
        const fvgHigh = c3.low;
        const fvgLow = c1.high;
        const fvgSize = fvgHigh - fvgLow;
        const entryPrice = fvgHigh - fvgSize * 0.22;  // 0.22 位置入场
        fvgs.push({
          type: 'bullish',
          high: fvgHigh,
          low: fvgLow,
          time: c2.time,
          filled: false,
          fillPercentage: 0,
          fib22: entryPrice,
          entry: entryPrice,      // 入场点
          stopLoss: fvgLow,       // 止损在底部边界
        });
      }
    }

    // Bearish FVG: c3.high < c1.low
    if (c3.high < c1.low) {
      const gapSize = c1.low - c3.high;
      const gapPercent = (gapSize / c2.close) * 100;
      if (gapPercent >= minGapPercent) {
        const fvgHigh = c1.low;
        const fvgLow = c3.high;
        const fvgSize = fvgHigh - fvgLow;
        const entryPrice = fvgLow + fvgSize * 0.22;  // 0.22 位置入场
        fvgs.push({
          type: 'bearish',
          high: fvgHigh,
          low: fvgLow,
          time: c2.time,
          filled: false,
          fillPercentage: 0,
          fib22: entryPrice,
          entry: entryPrice,      // 入场点
          stopLoss: fvgHigh,      // 止损在顶部边界
        });
      }
    }
  }

  // 用历史极值计算填充度（与前端一致）
  for (let fvgIdx = 0; fvgIdx < fvgs.length; fvgIdx++) {
    const fvg = fvgs[fvgIdx];
    const fvgSize = fvg.high - fvg.low;
    if (fvgSize <= 0) continue;

    // 找到 FVG 对应的 K 线索引
    const fvgCandleIdx = candles.findIndex(c => c.time === fvg.time);
    if (fvgCandleIdx < 0) continue;

    // 遍历后续 K 线，用极值计算最大填充深度
    for (let j = fvgCandleIdx + 1; j < candles.length; j++) {
      if (fvg.type === 'bullish') {
        // 看涨 FVG：价格从上方进入，用 low 极值
        if (candles[j].low <= fvg.low) {
          fvg.filled = true;
          fvg.fillPercentage = 100;
          break;
        }
        if (candles[j].low < fvg.high) {
          const filled = ((fvg.high - candles[j].low) / fvgSize) * 100;
          fvg.fillPercentage = Math.max(fvg.fillPercentage, Math.min(100, filled));
        }
      } else {
        // 看跌 FVG：价格从下方进入，用 high 极值
        if (candles[j].high >= fvg.high) {
          fvg.filled = true;
          fvg.fillPercentage = 100;
          break;
        }
        if (candles[j].high > fvg.low) {
          const filled = ((candles[j].high - fvg.low) / fvgSize) * 100;
          fvg.fillPercentage = Math.max(fvg.fillPercentage, Math.min(100, filled));
        }
      }
    }
  }

  // 返回未填充的 FVG
  return fvgs.filter(f => !f.filled && f.fillPercentage < 80).slice(-15);
}

// ============================================
// Order Block 检测 (基于 LuxAlgo 方法)
// ============================================

export function detectOrderBlocks(
  candles: Candle[],
  length: number = 10,
  showBull: number = 10,
  showBear: number = 10
): OrderBlock[] {
  if (candles.length < length + 10) return [];

  const getMax = (c: Candle) => c.high;
  const getMin = (c: Candle) => c.low;

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
    locIndex: number;  // K 线索引，用于计算填充度
    breaker: boolean;
  }

  const bullishOBs: OBTrack[] = [];
  const bearishOBs: OBTrack[] = [];

  let os = 0;
  let topSwing: Swing | null = null;
  let btmSwing: Swing | null = null;

  for (let i = length; i < candles.length; i++) {
    const candle = candles[i];
    const candleAtLen = candles[i - length];

    let upper = -Infinity;
    let lower = Infinity;
    for (let j = i - length + 1; j < i; j++) {
      upper = Math.max(upper, candles[j].high);
      lower = Math.min(lower, candles[j].low);
    }

    const prevOs = os;
    if (candleAtLen.high > upper) {
      os = 0;
    } else if (candleAtLen.low < lower) {
      os = 1;
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

      bullishOBs.unshift({ top: maxima, btm: minima, loc, locIndex, breaker: false });
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

      bearishOBs.unshift({ top: maxima, btm: minima, loc, locIndex, breaker: false });
    }

    // Check for mitigation
    for (let j = bullishOBs.length - 1; j >= 0; j--) {
      const ob = bullishOBs[j];
      if (!ob.breaker && Math.min(candle.close, candle.open) < ob.btm) {
        ob.breaker = true;
      } else if (ob.breaker && candle.close > ob.top) {
        bullishOBs.splice(j, 1);
      }
    }

    for (let j = bearishOBs.length - 1; j >= 0; j--) {
      const ob = bearishOBs[j];
      if (!ob.breaker && Math.max(candle.close, candle.open) > ob.top) {
        ob.breaker = true;
      } else if (ob.breaker && candle.close < ob.btm) {
        bearishOBs.splice(j, 1);
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
        // 看涨 OB：价格从上方进入，用 low 极值
        if (candles[j].low <= obBtm) {
          return 100;
        }
        if (candles[j].low <= obTop) {
          const filled = ((obTop - candles[j].low) / obSize) * 100;
          fillPercentage = Math.max(fillPercentage, Math.min(100, filled));
        }
      } else {
        // 看跌 OB：价格从下方进入，用 high 极值
        if (candles[j].high >= obTop) {
          return 100;
        }
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
    const fib22 = ob.top - obSize * 0.22;  // 看涨：顶部往下 22%
    result.push({
      type: 'bullish',
      high: ob.top,
      low: ob.btm,
      startTime: ob.loc,
      mitigated: false,
      strength: 0,
      fillPercentage,
      fib22,
    });
  }

  const activeBearish = bearishOBs.filter(ob => !ob.breaker).slice(0, showBear);
  for (const ob of activeBearish) {
    const obSize = ob.top - ob.btm;
    const fillPercentage = calculateFillPercentage(ob.top, ob.btm, ob.locIndex, 'bearish');
    const fib22 = ob.btm + obSize * 0.22;  // 看跌：底部往上 22%
    result.push({
      type: 'bearish',
      high: ob.top,
      low: ob.btm,
      startTime: ob.loc,
      mitigated: false,
      strength: 0,
      fillPercentage,
      fib22,
    });
  }

  return result;
}

// ============================================
// OTE 区域检测
// ============================================

export function detectOTEZones(
  swingPoints: SwingPoint[],
  currentPrice: number,
  candles: Candle[] = [],
  maxZones: number = 10
): OTEZone[] {
  const zones: OTEZone[] = [];

  if (swingPoints.length < 2) return zones;

  // 按时间倒序排列（最新的在前）
  const sorted = [...swingPoints].sort((a, b) => b.time - a.time);

  for (let i = 0; i < sorted.length - 1 && zones.length < maxZones; i++) {
    const current = sorted[i];
    const prev = sorted[i + 1];

    // Bullish OTE: high 之后找 low（价格回撤后做多）
    if (current.type === 'high' && prev.type === 'low') {
      const swingHigh = current.price;
      const swingLow = prev.price;
      const range = swingHigh - swingLow;

      if (range <= 0) continue;

      const fib618 = swingHigh - range * 0.618;
      const fib786 = swingHigh - range * 0.786;
      const fib675 = swingHigh - range * 0.675;
      const stopLossPrice = swingHigh - range * 0.80;

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

      // 只有当区域在当前价格下方时才是做多机会
      if (fib786 > currentPrice) continue;

      zones.push({
        type: 'bullish',
        startTime: current.time,
        swingHigh,
        swingLow,
        fib618,
        fib786,
        fib675,
        active: currentPrice >= fib786 && currentPrice <= fib618,
        entry: fib675,
        stopLoss: stopLossPrice,
      });
    }

    // Bearish OTE: low 之后找 high（价格反弹后做空）
    if (current.type === 'low' && prev.type === 'high') {
      const swingHigh = prev.price;
      const swingLow = current.price;
      const range = swingHigh - swingLow;

      if (range <= 0) continue;

      const fib618 = swingLow + range * 0.618;
      const fib786 = swingLow + range * 0.786;
      const fib675 = swingLow + range * 0.675;
      const stopLossPrice = swingLow + range * 0.80;

      // 检查历史 K 线是否已经完全穿过区域
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

      // 只有当区域在当前价格上方时才是做空机会
      if (fib618 < currentPrice) continue;

      zones.push({
        type: 'bearish',
        startTime: current.time,
        swingHigh,
        swingLow,
        fib618,
        fib786,
        fib675,
        active: currentPrice >= fib618 && currentPrice <= fib786,
        entry: fib675,
        stopLoss: stopLossPrice,
      });
    }
  }

  return zones;
}

// ============================================
// BOS & CHoCH 检测
// ============================================

export function detectStructure(
  swingPoints: SwingPoint[],
  currentPrice: number
): { bos: BOS[]; choch: CHoCH[] } {
  const bos: BOS[] = [];
  const choch: CHoCH[] = [];

  if (swingPoints.length < 4) return { bos, choch };

  // 确定当前趋势
  const recentHighs = swingPoints.filter(s => s.type === 'high').slice(-3);
  const recentLows = swingPoints.filter(s => s.type === 'low').slice(-3);

  let trend: 'up' | 'down' | 'neutral' = 'neutral';
  if (recentHighs.length >= 2 && recentLows.length >= 2) {
    const higherHighs = recentHighs[recentHighs.length - 1].price > recentHighs[0].price;
    const higherLows = recentLows[recentLows.length - 1].price > recentLows[0].price;
    const lowerHighs = recentHighs[recentHighs.length - 1].price < recentHighs[0].price;
    const lowerLows = recentLows[recentLows.length - 1].price < recentLows[0].price;

    if (higherHighs && higherLows) trend = 'up';
    else if (lowerHighs && lowerLows) trend = 'down';
  }

  // 检测 BOS 和 CHoCH
  for (let i = 1; i < swingPoints.length; i++) {
    const prev = swingPoints
      .slice(0, i)
      .filter(s => s.type === swingPoints[i].type)
      .pop();
    if (!prev) continue;

    const curr = swingPoints[i];

    if (curr.type === 'high' && curr.price > prev.price) {
      if (trend === 'up') {
        bos.push({ type: 'bullish', level: prev.price, time: curr.time });
      } else if (trend === 'down') {
        choch.push({
          type: 'bullish',
          level: prev.price,
          time: curr.time,
          previousTrend: 'down',
        });
      }
    } else if (curr.type === 'low' && curr.price < prev.price) {
      if (trend === 'down') {
        bos.push({ type: 'bearish', level: prev.price, time: curr.time });
      } else if (trend === 'up') {
        choch.push({
          type: 'bearish',
          level: prev.price,
          time: curr.time,
          previousTrend: 'up',
        });
      }
    }
  }

  return { bos: bos.slice(-5), choch: choch.slice(-3) };
}

// ============================================
// 综合分析
// ============================================

export function analyzeICT(
  candles: Candle[],
  symbol: string,
  timeframe: Timeframe
): ICTAnalysisResult {
  const currentPrice = candles[candles.length - 1].close;

  // 计算所有 ICT 指标
  const swingPoints = detectSwingPoints(candles);
  const fvgs = detectFVGs(candles);
  const orderBlocks = detectOrderBlocks(candles);
  const oteZones = detectOTEZones(swingPoints, currentPrice, candles);
  const { bos, choch } = detectStructure(swingPoints, currentPrice);

  // 判断趋势
  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (choch.length > 0) {
    trend = choch[choch.length - 1].type;
  } else if (bos.length > 0) {
    trend = bos[bos.length - 1].type;
  }

  // 提取关键价位
  const keyLevels: { level: number; type: string; strength: number }[] = [];

  // 添加活跃的 OTE 区域
  for (const ote of oteZones.filter(z => z.active)) {
    keyLevels.push({ level: ote.fib675, type: `OTE ${ote.type}`, strength: 3 });
  }

  // 添加未填充的 FVG
  for (const fvg of fvgs.filter(f => !f.filled).slice(0, 3)) {
    keyLevels.push({ level: fvg.fib22, type: `FVG ${fvg.type}`, strength: 2 });
  }

  return {
    symbol,
    timeframe,
    timestamp: Date.now(),
    currentPrice,
    swingPoints,
    orderBlocks,
    fvgs,
    oteZones,
    bos,
    choch,
    liquidityZones: [], // 简化版本暂不实现
    trend,
    keyLevels,
  };
}
