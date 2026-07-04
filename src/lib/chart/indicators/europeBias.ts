/**
 * Europe Open Window Bias — Premium/Discount 判定
 *
 * 算法（与 Asia Open 完全对称）：
 * 1. 范围 = 当日 0:00 北京 到 15:30 北京 的 K 线（EO 窗口前）
 * 2. 算 range H, L, EQ
 * 3. 判定当前价（EO 第 2 根 K 线 close）在 Premium 还是 Discount
 * 4. 应用规则：
 *    - Premium: EO H 破 range H → LONG，否则 SHORT
 *    - Discount: EO L 破 range L → SHORT，否则 LONG
 */

import { Candle } from "@/types/chart";

export type EuropeBiasDirection = "long" | "short";

export interface EuropeBiasData {
  direction: EuropeBiasDirection;
  /** EO 2 根 15m K 线 (15:30-16:00 北京) 的最高 */
  europeOpenHigh: number;
  /** EO 2 根 15m K 线的最低 */
  europeOpenLow: number;
  /** EO 起始时间（UTC 秒） */
  europeOpenTime: number;
  /** 当日 0:00-15:30 北京 范围 H */
  rangeHigh: number;
  /** 当日 0:00-15:30 北京 范围 L */
  rangeLow: number;
  /** 范围 EQ = (rangeHigh + rangeLow) / 2 */
  rangeEQ: number;
  /** EO 第 2 根 K 线的 close */
  currentPrice: number;
  /** currentPrice >= rangeEQ */
  inPremium: boolean;
  /** 计算时间（毫秒） */
  computedAt: number;
}

function beijingMidnightUtcSec(date: Date): number {
  const beijingDateStr = date.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const [y, m, d] = beijingDateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) - 8 * 3600;
}

export function computeEuropeBias(
  candles15m: Candle[],
  nowMs: number = Date.now()
): EuropeBiasData | null {
  if (candles15m.length < 2) return null;

  const now = new Date(nowMs);
  const beijingMidnightUtc = beijingMidnightUtcSec(now);

  // 范围 = 0:00-15:30 北京
  const rangeStartUtc = beijingMidnightUtc;
  const rangeEndUtc = beijingMidnightUtc + 15 * 3600 + 30 * 60; // 15:30 北京

  // EO 2 根 15m K-line: 15:30-15:45 + 15:45-16:00
  const eoStart1Utc = rangeEndUtc; // 15:30 北京 = 7:30 UTC
  const eoStart2Utc = rangeEndUtc + 15 * 60; // 15:45 北京 = 7:45 UTC

  // 16:00 北京之前 → EO 窗口未完成
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec < eoStart2Utc + 15 * 60) {
    return null;
  }

  // 找 EO 2 根 K 线
  const c1 = candles15m.find((c) => c.time === eoStart1Utc);
  const c2 = candles15m.find((c) => c.time === eoStart2Utc);
  if (!c1 || !c2) return null;

  const europeOpenHigh = Math.max(c1.high, c2.high);
  const europeOpenLow = Math.min(c1.low, c2.low);
  const currentPrice = c2.close;

  // 范围 K 线（0:00-15:30 北京）
  const rangeCandles = candles15m.filter(
    (c) => c.time >= rangeStartUtc && c.time < rangeEndUtc
  );
  if (rangeCandles.length === 0) return null;

  const rangeHigh = Math.max(...rangeCandles.map((c) => c.high));
  const rangeLow = Math.min(...rangeCandles.map((c) => c.low));
  const rangeEQ = (rangeHigh + rangeLow) / 2;

  // 判定
  const inPremium = currentPrice >= rangeEQ;
  let direction: EuropeBiasDirection;

  if (inPremium) {
    // Premium: 期望 EO 向上破 H；破 = LONG，未破 = SHORT
    direction = europeOpenHigh > rangeHigh ? "long" : "short";
  } else {
    // Discount: 期望 EO 向下破 L；破 = SHORT，未破 = LONG
    direction = europeOpenLow < rangeLow ? "short" : "long";
  }

  return {
    direction,
    europeOpenHigh,
    europeOpenLow,
    europeOpenTime: eoStart1Utc,
    rangeHigh,
    rangeLow,
    rangeEQ,
    currentPrice,
    inPremium,
    computedAt: nowMs,
  };
}
