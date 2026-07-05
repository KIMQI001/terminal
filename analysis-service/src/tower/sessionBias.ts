/**
 * Session Bias 计算 — 守塔策略用
 *
 * Port from terminal/src/lib/chart/indicators/{asiaBias,europeBias,initialBalance}.ts
 *
 * 3 个 session 的 bias：
 *   - AO  (Asia Open):   7:45-8:15  北京
 *   - EO  (Europe Open): 15:30-16:00 北京
 *   - AI  (Always In):   21:00-22:00 北京
 *
 * 每个 session 用"前一个 session"的 H/L 当参考：
 *   - AO  → pre-Asia (0:00-7:45 北京)
 *   - EO  → Asia     (8:00-14:00 北京)
 *   - AI  → Europe   (15:00-20:00 北京)
 *
 * Premium/Discount 规则：
 *   - Premium (close >= EQ):  当 window 破前高 → long, 否则 short
 *   - Discount (close < EQ):  当 window 破前低 → short, 否则 long
 */

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ============================================
// Types
// ============================================

export type BiasDirection = "long" | "short";

export interface AsiaBiasData {
  direction: BiasDirection;
  asiaOpenHigh: number;
  asiaOpenLow: number;
  asiaOpenTime: number;
  rangeHigh: number;
  rangeLow: number;
  rangeEQ: number;
  currentPrice: number;
  inPremium: boolean;
}

export interface EuropeBiasData {
  direction: BiasDirection;
  europeOpenHigh: number;
  europeOpenLow: number;
  europeOpenTime: number;
  asiaHigh: number;
  asiaLow: number;
  asiaEQ: number;
  currentPrice: number;
  inPremium: boolean;
}

export interface InitialBalanceData {
  direction: BiasDirection;
  ibHigh: number;
  ibLow: number;
  ibTime: number;
  europeHigh: number;
  europeLow: number;
  europeEQ: number;
  currentPrice: number;
  inPremium: boolean;
}

// ============================================
// Time helpers
// ============================================

/** 当日北京 0:00 对应的 UTC 时间戳（秒） */
function beijingMidnightUtcSec(date: Date): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  // 用 UTC 时间反推北京日期
  // 北京 0:00 = UTC (y, m, d-1) 16:00
  return Math.floor(Date.UTC(y, m, d - 1) / 1000) + 16 * 3600;
}

/** 当前北京时间的"总分钟数" 0-1439 */
function getBeijingTotalMinutes(now: Date = new Date()): number {
  // 转为北京时区
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  return beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
}

/** 当前是否在 AI session（22:00-05:00 北京，跨 00:00） */
function isAISessionActive(now: Date = new Date()): boolean {
  const min = getBeijingTotalMinutes(now);
  return min >= 22 * 60 || min < 5 * 60;
}

// ============================================
// Asia Open Bias
// ============================================

export function computeAsiaBias(
  candles15m: Candle[],
  nowMs: number = Date.now()
): AsiaBiasData | null {
  if (candles15m.length < 2) return null;
  const now = new Date(nowMs);
  const beijingMidnightUtc = beijingMidnightUtcSec(now);

  // Range = 0:00-7:45 北京（pre-Asia）
  const rangeStartUtc = beijingMidnightUtc;
  const rangeEndUtc = beijingMidnightUtc + 7 * 3600 + 45 * 60;

  // AO 2 根 15m K-line: 7:45-8:15 北京
  const aoStart1Utc = rangeEndUtc;
  const aoStart2Utc = rangeEndUtc + 15 * 60;

  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec < aoStart2Utc + 15 * 60) return null;

  const c1 = candles15m.find((c) => c.time === aoStart1Utc);
  const c2 = candles15m.find((c) => c.time === aoStart2Utc);
  if (!c1 || !c2) return null;

  const asiaOpenHigh = Math.max(c1.high, c2.high);
  const asiaOpenLow = Math.min(c1.low, c2.low);
  const currentPrice = c2.close;

  const rangeCandles = candles15m.filter(
    (c) => c.time >= rangeStartUtc && c.time < rangeEndUtc
  );
  if (rangeCandles.length === 0) return null;

  const rangeHigh = Math.max(...rangeCandles.map((c) => c.high));
  const rangeLow = Math.min(...rangeCandles.map((c) => c.low));
  const rangeEQ = (rangeHigh + rangeLow) / 2;

  const inPremium = currentPrice >= rangeEQ;
  const direction: BiasDirection = inPremium
    ? asiaOpenHigh > rangeHigh ? "long" : "short"
    : asiaOpenLow < rangeLow ? "short" : "long";

  return {
    direction,
    asiaOpenHigh,
    asiaOpenLow,
    asiaOpenTime: aoStart1Utc,
    rangeHigh,
    rangeLow,
    rangeEQ,
    currentPrice,
    inPremium,
  };
}

// ============================================
// Europe Open Bias
// ============================================

export function computeEuropeBias(
  candles15m: Candle[],
  nowMs: number = Date.now()
): EuropeBiasData | null {
  if (candles15m.length < 2) return null;
  const now = new Date(nowMs);
  const beijingMidnightUtc = beijingMidnightUtcSec(now);

  // Asia Zone = 8:00-14:00 北京 = 00:00-06:00 UTC of "today"
  const asiaStartUtc = beijingMidnightUtc;
  const asiaEndUtc = beijingMidnightUtc + 6 * 3600;

  // EO 2 根 15m K-line: 15:30-16:00 北京 = 7:30-8:00 UTC
  const eoStart1Utc = beijingMidnightUtc + 7 * 3600 + 30 * 60;
  const eoStart2Utc = beijingMidnightUtc + 7 * 3600 + 45 * 60;

  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec < eoStart2Utc + 15 * 60) return null;

  const c1 = candles15m.find((c) => c.time === eoStart1Utc);
  const c2 = candles15m.find((c) => c.time === eoStart2Utc);
  if (!c1 || !c2) return null;

  const europeOpenHigh = Math.max(c1.high, c2.high);
  const europeOpenLow = Math.min(c1.low, c2.low);
  const currentPrice = c2.close;

  const asiaCandles = candles15m.filter(
    (c) => c.time >= asiaStartUtc && c.time < asiaEndUtc
  );
  if (asiaCandles.length === 0) return null;

  const asiaHigh = Math.max(...asiaCandles.map((c) => c.high));
  const asiaLow = Math.min(...asiaCandles.map((c) => c.low));
  const asiaEQ = (asiaHigh + asiaLow) / 2;

  const inPremium = currentPrice >= asiaEQ;
  const direction: BiasDirection = inPremium
    ? europeOpenHigh > asiaHigh ? "long" : "short"
    : europeOpenLow < asiaLow ? "short" : "long";

  return {
    direction,
    europeOpenHigh,
    europeOpenLow,
    europeOpenTime: eoStart1Utc,
    asiaHigh,
    asiaLow,
    asiaEQ,
    currentPrice,
    inPremium,
  };
}

// ============================================
// Always In (Initial Balance) Bias
// ============================================

/** 找最近一根已完成的 13:00 UTC 起始的 1h K 线（IB） */
function findIBCandle(
  hourlyCandles: Candle[],
  nowSec: number
): Candle | null {
  if (hourlyCandles.length === 0) return null;
  const todayMidnightUtc = nowSec - (nowSec % 86400);
  let ibUtcTime = todayMidnightUtc + 13 * 3600;
  if (nowSec < ibUtcTime + 3600) {
    ibUtcTime -= 86400; // 今天的 IB 还没结束，用昨天的
  }
  for (const c of hourlyCandles) {
    if (c.time === ibUtcTime) return c;
  }
  // 兜底
  let fallback: Candle | null = null;
  for (const c of hourlyCandles) {
    if (c.time > ibUtcTime) break;
    fallback = c;
  }
  return fallback;
}

/** 找 Europe Zone 范围 (7:00-12:00 UTC of "today") 的 H/L */
function findEuropeZoneHL(
  fifteenMinCandles: Candle[],
  nowSec: number
): { high: number; low: number } | null {
  const todayMidnightUtc = nowSec - (nowSec % 86400);
  const europeStart = todayMidnightUtc + 7 * 3600;
  const europeEnd = todayMidnightUtc + 12 * 3600;

  const europeCandles = fifteenMinCandles.filter(
    (c) => c.time >= europeStart && c.time < europeEnd
  );
  if (europeCandles.length === 0) return null;

  return {
    high: Math.max(...europeCandles.map((c) => c.high)),
    low: Math.min(...europeCandles.map((c) => c.low)),
  };
}

export function computeInitialBalance(
  hourlyCandles: Candle[],
  fifteenMinCandles: Candle[],
  nowMs: number = Date.now()
): InitialBalanceData | null {
  const nowSec = Math.floor(nowMs / 1000);

  const ibCandle = findIBCandle(hourlyCandles, nowSec);
  const europeZone = findEuropeZoneHL(fifteenMinCandles, nowSec);
  if (!ibCandle || !europeZone) return null;

  const currentPrice = ibCandle.close;
  const europeEQ = (europeZone.high + europeZone.low) / 2;
  const inPremium = currentPrice >= europeEQ;

  const direction: BiasDirection = inPremium
    ? ibCandle.high > europeZone.high ? "long" : "short"
    : ibCandle.low < europeZone.low ? "short" : "long";

  return {
    direction,
    ibHigh: ibCandle.high,
    ibLow: ibCandle.low,
    ibTime: ibCandle.time,
    europeHigh: europeZone.high,
    europeLow: europeZone.low,
    europeEQ,
    currentPrice,
    inPremium,
  };
}

// ============================================
// 一站式：算全部 3 个 + 选 active
// ============================================

export interface AllSessionBiases {
  asia: AsiaBiasData | null;
  europe: EuropeBiasData | null;
  ai: InitialBalanceData | null;
  active: BiasDirection | 'wait';
  activeSession: 'AO' | 'EO' | 'AI';
  computedAt: number;
}

export function computeAllSessionBiases(
  hourlyCandles: Candle[],
  fifteenMinCandles: Candle[],
  nowMs: number = Date.now()
): AllSessionBiases {
  const asia = computeAsiaBias(fifteenMinCandles, nowMs);
  const europe = computeEuropeBias(fifteenMinCandles, nowMs);
  const ai = computeInitialBalance(hourlyCandles, fifteenMinCandles, nowMs);

  const now = new Date(nowMs);
  const min = getBeijingTotalMinutes(now);
  let activeSession: 'AO' | 'EO' | 'AI';
  let activeBias: BiasDirection | undefined;

  if (min < 5 * 60 || min >= 22 * 60) {
    activeSession = 'AI';
    activeBias = ai?.direction;
  } else if (min < 15 * 60) {
    activeSession = 'AO';
    activeBias = asia?.direction;
  } else {
    activeSession = 'EO';
    activeBias = europe?.direction;
  }

  return {
    asia,
    europe,
    ai,
    active: activeBias ?? 'wait',
    activeSession,
    computedAt: nowMs,
  };
}
