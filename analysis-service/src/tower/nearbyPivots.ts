/**
 * 附近 Pivot 检测（HH/LH/HL/LL）
 *
 * 算法与前端 src/components/ai/InlineAIDisplay.tsx 的 calculateNearbyPivots 完全一致：
 * 1. 用 lookback=5 的非对称 swing 检测（只检查左侧 5 根 K 线）
 * 2. 分离高/低点，按时间倒序
 * 3. 找上方最近的 2 个高点作为 HH/LH，下方最近的 2 个低点作为 LL/HL
 *
 * 用作守塔策略的 "不破" 订单入口：在最新 HH 附近的 LH 下 SELL，在最新 LL 附近的 HL 下 BUY。
 */

import { Candle } from '../data/klineClient';

export interface PivotPoint {
  price: number;
  time: number;
}

export interface PivotSet {
  hh: PivotPoint | null;
  lh: PivotPoint | null;
  hl: PivotPoint | null;
  ll: PivotPoint | null;
}

interface SwingPoint {
  type: 'high' | 'low';
  price: number;
  time: number;
  index: number;
}

/**
 * 非对称 swing 检测：检查左侧 lookback 根 K 线，当前 bar 是高点/低点
 * - 不检查右侧（避免未来数据泄露）
 * - 实时可用
 */
function detectAsymmetricSwings(candles: Candle[], lookback: number = 5): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (let i = lookback; i < candles.length; i++) {
    const current = candles[i];

    // 检测 Pivot High：当前 high 高于左侧 lookback 根
    let isPivotHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= current.high) {
        isPivotHigh = false;
        break;
      }
    }
    if (isPivotHigh) {
      swings.push({ type: 'high', price: current.high, time: current.time, index: i });
    }

    // 检测 Pivot Low：当前 low 低于左侧 lookback 根
    let isPivotLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].low <= current.low) {
        isPivotLow = false;
        break;
      }
    }
    if (isPivotLow) {
      swings.push({ type: 'low', price: current.low, time: current.time, index: i });
    }
  }

  return swings;
}

/**
 * 计算当前价格附近的 HH/LH/HL/LL
 * - HH = 上方第二近的高点
 * - LH = 上方最近的高点
 * - HL = 下方最近的低点
 * - LL = 下方第二近的低点
 */
export function calculateNearbyPivots(candles: Candle[], currentPrice: number, lookback: number = 5): PivotSet {
  if (candles.length < 10) return { hh: null, lh: null, hl: null, ll: null };

  const swings = detectAsymmetricSwings(candles, lookback);
  if (swings.length < 4) return { hh: null, lh: null, hl: null, ll: null };

  // 分离高低点，按时间倒序（最近的在前）
  const highs = swings.filter(s => s.type === 'high').sort((a, b) => b.time - a.time);
  const lows = swings.filter(s => s.type === 'low').sort((a, b) => b.time - a.time);

  // 上方高点（高于当前价）
  const higherHighs = highs.filter(h => h.price > currentPrice);
  let hh: PivotPoint | null = null;
  let lh: PivotPoint | null = null;

  if (higherHighs.length >= 2) {
    hh = { price: higherHighs[1].price, time: higherHighs[1].time };
    lh = { price: higherHighs[0].price, time: higherHighs[0].time };
  } else if (higherHighs.length === 1) {
    hh = { price: higherHighs[0].price, time: higherHighs[0].time };
  }

  // 下方低点（低于当前价）
  const lowerLows = lows.filter(l => l.price < currentPrice);
  let ll: PivotPoint | null = null;
  let hl: PivotPoint | null = null;

  if (lowerLows.length >= 2) {
    ll = { price: lowerLows[1].price, time: lowerLows[1].time };
    hl = { price: lowerLows[0].price, time: lowerLows[0].time };
  } else if (lowerLows.length === 1) {
    ll = { price: lowerLows[0].price, time: lowerLows[0].time };
  }

  return { hh, lh, hl, ll };
}
