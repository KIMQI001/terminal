/**
 * Session Bias 单元测试
 *
 * 覆盖以下回归 bug：
 * 1. Asia Zone +8h 偏移（之前用 beijingMidnightUtc 当 0:00 北京，会包含 pre-Asia 时段 0:00-7:45）
 * 2. EO K-lines +8h 偏移（之前用 +7.75/+8h = 早上 7:45/8:00，应该用 +15.75/+16h = 下午 15:45/16:00）
 * 3. AI 跨日 session 22:00-05:00（不是 22:00-24:00）
 */

import { describe, it, expect } from 'vitest';
import {
  computeAsiaBias,
  computeEuropeBias,
  computeInitialBalance,
  computeAllSessionBiases,
} from '../sessionBias';
import type { Candle } from '../../data/klineClient';

// ============================================
// 时间常量
// ============================================
// 参考时间：2026-07-04 17:00 北京 = 2026-07-04 09:00 UTC
const TEST_NOW_MS = Date.UTC(2026, 6, 4, 9, 0, 0);

// beijingMidnightUtc = 0:00 北京 of 2026-07-04 = 16:00 UTC of 2026-07-03
const BEIJING_MIDNIGHT = 1781299200;
// 0:00 UTC of today (Beijing) = 8:00 北京
const TODAY_UTC_MIDNIGHT = BEIJING_MIDNIGHT + 8 * 3600;

// Asia Zone (EO 参考): 8:00-14:00 北京 = 0:00-6:00 UTC of today
const ASIA_ZONE_START = TODAY_UTC_MIDNIGHT;            // 0:00 UTC today = 8:00 北京
const ASIA_ZONE_END = TODAY_UTC_MIDNIGHT + 6 * 3600;  // 6:00 UTC today = 14:00 北京

// AO 2 K-lines: 7:45-8:00 + 8:00-8:15 北京
const AO_1ST = BEIJING_MIDNIGHT + 7 * 3600 + 45 * 60; // 23:45 UTC prev day
const AO_2ND = BEIJING_MIDNIGHT + 8 * 3600;           // 0:00 UTC today

// EO 2 K-lines: 15:45-16:00 + 16:00-16:15 北京（不是 7:45/8:00 AM）
const EO_1ST = BEIJING_MIDNIGHT + 15 * 3600 + 45 * 60; // 7:45 UTC today
const EO_2ND = BEIJING_MIDNIGHT + 16 * 3600;          // 8:00 UTC today

// AI IB 1h K-line: 21:00-22:00 北京
const AI_IB_TIME = BEIJING_MIDNIGHT + 13 * 3600;       // 13:00 UTC today

// Europe Zone (AI 参考): 15:00-20:00 北京 = 7:00-12:00 UTC of today
const EUROPE_ZONE_START = TODAY_UTC_MIDNIGHT + 7 * 3600;  // 7:00 UTC today
const EUROPE_ZONE_END = TODAY_UTC_MIDNIGHT + 12 * 3600;   // 12:00 UTC today

// ============================================
// Mock helpers
// ============================================
function c(time: number, o: number, h: number, l: number, cl: number): Candle {
  return { time: time, open: o, high: h, low: l, close: cl };
}

/** 生成一段时间内的 flat K 线（用于 range 测试） */
function flatRange(start: number, end: number, interval: number, price: number): Candle[] {
  const candles: Candle[] = [];
  for (let t = start; t < end; t += interval) {
    candles.push(c(t, price, price, price, price));
  }
  return candles;
}

/** 完整 24h K 线 (15m 一根，96 根)，从 0:00 北京开始 */
function fullDayCandles(basePrice: number): Candle[] {
  return flatRange(BEIJING_MIDNIGHT, BEIJING_MIDNIGHT + 24 * 3600, 900, basePrice);
}

// ============================================
// computeAsiaBias (AO) 测试
// ============================================
describe('AO (Asia Open) Bias', () => {
  it('before 7:45 北京 (1:45 before 2nd K-line close) → returns null', () => {
    // 7:00 北京 = AO 还没开始
    const now = Date.UTC(2026, 6, 4, 13, 0, 0) - 24 * 3600 * 1000 + 0;
    const candles = fullDayCandles(62000);
    expect(computeAsiaBias(candles, now)).toBeNull();
  });

  it('after 8:15 北京 (AO complete) → returns direction LONG when Premium + breaks H', () => {
    // 8:15 北京
    const now = Date.UTC(2026, 6, 4, 0, 15, 0);
    // Range 0:00-7:45 北京 (pre-Asia) 高点 63000
    // AO close = 62800, AO high = 63200 > 63000 → LONG
    const candles: Candle[] = [
      ...flatRange(BEIJING_MIDNIGHT, AO_1ST, 900, 62000),
      c(AO_1ST, 62500, 62600, 62400, 62500),  // 7:45 K
      c(AO_2ND, 62800, 63200, 62700, 62800),  // 8:00 K
    ];
    const result = computeAsiaBias(candles, now);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('long');  // Premium (close 62800 > EQ 62500) + breaks H (63200 > 63000)
  });

  it('AO range is 0:00-7:45 北京 (not including AO K-lines themselves)', () => {
    // 关键回归测试：确保 AO 的 range 不会包含 AO 自己的 2 根 K 线
    // 之前 bug: AO 范围包含了 AO 2 根 K 线 (逻辑错乱)
    const now = Date.UTC(2026, 6, 4, 0, 15, 0);
    const candles: Candle[] = [
      ...flatRange(BEIJING_MIDNIGHT, AO_1ST, 900, 62000),
      c(AO_1ST, 70000, 70000, 70000, 70000),  // AO K-line 极端值
      c(AO_2ND, 70000, 70000, 70000, 70000),  // AO K-line 极端值
    ];
    const result = computeAsiaBias(candles, now);
    expect(result).not.toBeNull();
    // range 不应被 AO K-line 70000 影响
    expect(result!.rangeHigh).toBe(62000);
    expect(result!.rangeLow).toBe(62000);
  });
});

// ============================================
// computeEuropeBias (EO) 测试
// ============================================
describe('EO (Europe Open) Bias', () => {
  it('before 15:45 北京 → returns null', () => {
    // 15:00 北京 = EO 还没开始
    const now = Date.UTC(2026, 6, 4, 7, 0, 0);
    const candles = fullDayCandles(62000);
    expect(computeEuropeBias(candles, now)).toBeNull();
  });

  it('Asia Zone is 8:00-14:00 北京 (NOT pre-Asia 0:00-7:45)', () => {
    // 关键回归测试：之前 bug 用 beijingMidnightUtc (= 0:00 北京 = 16:00 UTC 前一天)
    // 会包含 0:00-7:45 北京的 K 线（pre-Asia）
    // 应只包含 8:00-14:00 北京 = 0:00-6:00 UTC of today
    const now = Date.UTC(2026, 6, 4, 8, 0, 0); // 16:00 北京
    const candles: Candle[] = [
      // 0:00-7:45 北京 (pre-Asia) 极端值 70000 — 不应进入 Asia Zone
      ...flatRange(BEIJING_MIDNIGHT, ASIA_ZONE_START, 900, 70000),
      // 8:00-14:00 北京 (Asia Zone) 62000
      ...flatRange(ASIA_ZONE_START, ASIA_ZONE_END, 900, 62000),
      // 14:00-15:45 北京 (pre-EO) 65000
      ...flatRange(ASIA_ZONE_END, EO_1ST, 900, 65000),
      // EO 2 K-lines 62819-63036
      c(EO_1ST, 62900, 62950, 62850, 62900),
      c(EO_2ND, 63000, 63036, 62819, 63000),
    ];
    const result = computeEuropeBias(candles, now);
    expect(result).not.toBeNull();
    // Asia Zone 不应包含 pre-Asia 的 70000
    expect(result!.asiaHigh).toBe(62000);
    expect(result!.asiaLow).toBe(62000);
    // EO range = EO 2 K-lines
    expect(result!.europeOpenHigh).toBe(63036);
    expect(result!.europeOpenLow).toBe(62819);
  });

  it('EO K-lines are 15:45/16:00 北京 afternoon (NOT 7:45/8:00 AM morning)', () => {
    // 关键回归测试：之前 bug 用 +7.75/+8h = 早上 7:45/8:00 AM
    // 应是 +15.75/+16h = 下午 15:45/16:00
    const now = Date.UTC(2026, 6, 4, 8, 0, 0); // 16:00 北京
    const candles: Candle[] = [
      // Asia Zone
      ...flatRange(ASIA_ZONE_START, ASIA_ZONE_END, 900, 62000),
      // 早上 7:45 AM K-line (不应被当作 EO 1st)
      c(BEIJING_MIDNIGHT + 7 * 3600 + 45 * 60, 99999, 99999, 99999, 99999),
      // 早上 8:00 AM K-line (不应被当作 EO 2nd)
      c(BEIJING_MIDNIGHT + 8 * 3600, 99999, 99999, 99999, 99999),
      // 下午 15:45 K-line = 7:45 UTC today (EO 1st)
      c(EO_1ST, 62900, 63000, 62850, 62900),
      // 下午 16:00 K-line = 8:00 UTC today (EO 2nd)
      c(EO_2ND, 63000, 63050, 62900, 63000),
    ];
    const result = computeEuropeBias(candles, now);
    expect(result).not.toBeNull();
    // EO range 来自下午 15:45/16:00 K-lines (62850-63050)，不是早上 99999
    expect(result!.europeOpenHigh).toBe(63050);
    expect(result!.europeOpenLow).toBe(62850);
  });

  it('Premium + EO H > Asia H → LONG', () => {
    const now = Date.UTC(2026, 6, 4, 8, 0, 0);
    // Asia Zone: 62000-62400 (EQ = 62200)
    // EO: high 62500 > Asia H 62400 → LONG
    const candles: Candle[] = [
      ...flatRange(ASIA_ZONE_START, ASIA_ZONE_END, 900, 62000),
      c(EO_1ST, 62400, 62450, 62350, 62400),
      c(EO_2ND, 62450, 62500, 62400, 62450),  // close 62450 > EQ 62200 = Premium
    ];
    // Wait, EQ needs Asia high/low first
    // Let me redesign: Asia = 62000-62400 (EQ=62200)
    // EO close = 62450 > 62200 = Premium
    // EO high = max(62450, 62500) = 62500 > Asia H 62400 → LONG
    const result = computeEuropeBias(candles, now);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('long');
  });
});

// ============================================
// computeInitialBalance (AI) 测试
// ============================================
describe('AI (Always In) Bias', () => {
  it('before 22:00 北京 → returns null', () => {
    // 21:00 北京 = AI 还没开始
    const now = Date.UTC(2026, 6, 4, 13, 0, 0);
    const candles = fullDayCandles(62000);
    expect(computeInitialBalance(candles, candles, now)).toBeNull();
  });

  it('after 22:00 北京 (AI complete) → returns direction', () => {
    // 22:00 北京
    const now = Date.UTC(2026, 6, 4, 14, 0, 0);
    // Europe Zone 15:00-20:00 北京 = 7:00-12:00 UTC
    // Asia Zone 8:00-14:00 北京 = 0:00-6:00 UTC
    // IB 21:00-22:00 北京 = 13:00-14:00 UTC (AI_IB_TIME = 13*3600 offset)
    const candles: Candle[] = [
      // Europe Zone 62000-62200 (EQ=62100)
      ...flatRange(EUROPE_ZONE_START, EUROPE_ZONE_END, 900, 62000),
      // Asia Zone 62300
      ...flatRange(ASIA_ZONE_START, ASIA_ZONE_END, 900, 62300),
      // AI IB K-line: high 62400, low 62050, close 62150
      c(AI_IB_TIME, 62100, 62400, 62050, 62150),
    ];
    const result = computeInitialBalance(candles, candles, now);
    expect(result).not.toBeNull();
    expect(result!.direction).toBeDefined();
  });
});

// ============================================
// computeAllSessionBiases 测试
// ============================================
describe('computeAllSessionBiases', () => {
  it('picks AI session between 22:00-05:00 北京 (cross midnight)', () => {
    // 23:00 北京 = AI session
    const now = Date.UTC(2026, 6, 4, 15, 0, 0); // 23:00 北京
    const candles = fullDayCandles(62000);
    const result = computeAllSessionBiases(candles, candles, now);
    expect(result.activeSession).toBe('AI');
  });

  it('picks AO session between 5:00-15:00 北京', () => {
    // 12:00 北京 = AO session
    const now = Date.UTC(2026, 6, 4, 4, 0, 0); // 12:00 北京
    const candles = fullDayCandles(62000);
    const result = computeAllSessionBiases(candles, candles, now);
    expect(result.activeSession).toBe('AO');
  });

  it('picks EO session between 15:00-22:00 北京', () => {
    // 18:00 北京 = EO session
    const now = Date.UTC(2026, 6, 4, 10, 0, 0); // 18:00 北京
    const candles = fullDayCandles(62000);
    const result = computeAllSessionBiases(candles, candles, now);
    expect(result.activeSession).toBe('EO');
  });

  it('picks AI at 02:00 北京 (跨日 22:00-05:00 段)', () => {
    // 02:00 北京 = 18:00 UTC prev day
    // 注意：18:00 UTC of prev day = 02:00 北京 of today
    // The function should still pick AI (because 02:00 北京 is in 22:00-05:00 段)
    const prevDay = Date.UTC(2026, 6, 3, 18, 0, 0); // 2026-07-03 18:00 UTC = 2026-07-04 02:00 北京
    const candles = fullDayCandles(62000);
    const result = computeAllSessionBiases(candles, candles, prevDay);
    expect(result.activeSession).toBe('AI');
  });
});
