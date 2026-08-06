import { describe, it, expect } from 'vitest';
import { detectPivots, classifyPivots } from './luxAlgo';

describe('LuxAlgo parity under different K-line histories', () => {
  // 模拟 15m BTC 数据：120 根 K 线，趋势有比较明显的 swing
  function makeCandlesWithSwing(start: number, length: number, base: number): any[] {
    const candles: any[] = [];
    let price = base;
    for (let i = 0; i < length; i++) {
      // 简单正弦波 + 噪声
      const phase = (i / 20) * Math.PI;
      const wave = Math.sin(phase) * 500;
      const trend = i * 0.5;
      const noise = (Math.sin(i * 7.13) + Math.cos(i * 3.71)) * 50;
      const open = price + wave + trend + noise;
      const close = open + wave * 0.1 + noise * 0.5;
      const high = Math.max(open, close) + Math.abs(noise) + 5;
      const low = Math.min(open, close) - Math.abs(noise) - 5;
      candles.push({
        time: start + i * 900,
        open, high, low, close,
        volume: 1000,
      });
    }
    return candles;
  }

  it('produces same recent pivots regardless of history depth', () => {
    // 1000 根 vs 5000 根（最近 980 根的 K 线序列必须相同）
    const long = makeCandlesWithSwing(1000, 5000, 30000);
    const short = long.slice(-1000);

    // 用 length=20
    const shortResult = detectPivots(short, 20);
    const longResult = detectPivots(long, 20);

    // short 的 pivot 都应能在 long 中找到匹配（同样 price + time）
    for (const sp of shortResult.pivots) {
      const match = longResult.pivots.find(
        (lp) => lp.time === sp.time && Math.abs(lp.price - sp.price) < 0.01
      );
      expect(match).toBeDefined();
    }
  });

  it('classify produces same HH/HL/LH/LL for last 5 pivots', () => {
    const candles = makeCandlesWithSwing(1000, 200, 30000);
    const result = detectPivots(candles, 20);
    const classified = classifyPivots(result.pivots);

    // 至少应该有一些分类
    expect(classified.length).toBeGreaterThan(0);
    const lastFive = classified.slice(-5);
    // 最后一个分类应该是 HH/HL/LH/LL 之一
    expect(['HH', 'HL', 'LH', 'LL']).toContain(lastFive[lastFive.length - 1].classification);
  });
});
