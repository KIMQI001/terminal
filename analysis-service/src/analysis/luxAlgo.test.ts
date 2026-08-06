import { describe, it, expect } from 'vitest';
import { detectPivots, classifyPivots } from './luxAlgo';

describe('LuxAlgo pivot detection', () => {
  // 简单 V 形 / 倒 V 形 K 线
  function makeCandles(prices: number[]): any[] {
    return prices.map((p, i) => ({
      time: (i + 1) * 1000,
      open: p,
      high: p,
      low: p,
      close: p,
      volume: 0,
    }));
  }

  it('detects pivot high in a clear peak', () => {
    const candles = makeCandles([
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100, // 10 flat
      101, 103, 105, 110, 115, 108, 105, 102, 100, 98, // peak at 115
    ]);
    const result = detectPivots(candles, 10);
    const highs = result.pivots.filter(p => p.pivotType === 'high');
    expect(highs.length).toBeGreaterThan(0);
    expect(highs[0].price).toBe(115);
  });

  it('returns empty for too-few candles', () => {
    const candles = makeCandles([100, 101, 102, 103]);
    const result = detectPivots(candles, 10);
    expect(result.pivots).toEqual([]);
    expect(result.missedPivots).toEqual([]);
  });

  it('classifies swaps as HH/HL/LH/LL', () => {
    const candles = makeCandles([
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      110, 115, 110, 105, 100, 95, 100, 105, 110, 115,
      110, 105, 100, 95, 90, 95, 100, 105, 110, 100,
    ]);
    const result = detectPivots(candles, 10);
    const classified = classifyPivots(result.pivots);
    // 至少有 HH 或 LH 标记
    expect(classified.some(p => p.classification === 'HH' || p.classification === 'LH')).toBe(true);
  });

  // 关键 case: 与前端 pivotDetector.ts 行为一致
  // 输入: BTC 15m 数据典型的"两次新高形成 HH"
  it('matches frontend behavior for HH detection', () => {
    const candles = makeCandles([
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, // L1 baseline
      109, 111, 113, 115, 113, 111, 109, 111, 113, 115, // H1 = 115
      114, 113, 112, 114, 116, 118, 116, 114, 112, 110, // H2 = 118 (HH)
    ]);
    const result = detectPivots(candles, 10);
    const highs = result.pivots.filter(p => p.pivotType === 'high');
    expect(highs.length).toBeGreaterThanOrEqual(1);
    const classified = classifyPivots(highs);
    // 第二个 high 应该比第一个高 → HH
    if (classified.length >= 2) {
      expect(classified[classified.length - 1].classification).toBe('HH');
    }
  });
});
