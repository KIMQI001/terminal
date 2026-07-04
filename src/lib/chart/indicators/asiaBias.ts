/**
 * Asia Open Window Bias — Premium/Discount 判定
 *
 * 算法：
 * 1. 范围 = 当日 0:00 北京 到 7:45 北京 的 K 线（AO 窗口前）
 * 2. 算 range H, L, EQ（EQ = (H+L)/2）
 * 3. 判定当前价（AO 第 2 根 K 线的 close）在 Premium 还是 Discount
 * 4. 应用规则：
 *    - Premium (价格 >= EQ): AO 2 根 K 线的 H 破 range H → LONG，否则 SHORT
 *      （溢价区理应继续向上创新高，失败 = 弱势）
 *    - Discount (价格 < EQ): AO 2 根 K 线的 L 破 range L → SHORT，否则 LONG
 *      （折价区理应继续向下创新低，失败 = 强势）
 */

import { Candle } from "@/types/chart";

export type AsiaBiasDirection = "long" | "short";

export interface AsiaBiasData {
  direction: AsiaBiasDirection;
  /** AO 2 根 15m K 线 (7:45-8:15 北京) 的最高 */
  asiaOpenHigh: number;
  /** AO 2 根 15m K 线的最低 */
  asiaOpenLow: number;
  /** AO 起始时间（UTC 秒） */
  asiaOpenTime: number;
  /** 当日 0:00-7:45 北京 范围 H */
  rangeHigh: number;
  /** 当日 0:00-7:45 北京 范围 L */
  rangeLow: number;
  /** 范围 EQ = (rangeHigh + rangeLow) / 2 */
  rangeEQ: number;
  /** AO 第 2 根 K 线的 close，作为判断 Premium/Discount 的价格 */
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

export function computeAsiaBias(
  candles15m: Candle[],
  nowMs: number = Date.now()
): AsiaBiasData | null {
  if (candles15m.length < 2) return null;

  const now = new Date(nowMs);
  const beijingMidnightUtc = beijingMidnightUtcSec(now);

  // 范围 = 0:00-7:45 北京
  const rangeStartUtc = beijingMidnightUtc;
  const rangeEndUtc = beijingMidnightUtc + 7 * 3600 + 45 * 60; // 7:45 北京

  // AO 2 根 15m K-line: 7:45-8:00 + 8:00-8:15
  const aoStart1Utc = rangeEndUtc; // 7:45 北京 = 23:45 UTC
  const aoStart2Utc = rangeEndUtc + 15 * 60; // 8:00 北京 = 00:00 UTC (次日)

  // 8:15 北京之前 → AO 窗口未完成
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec < aoStart2Utc + 15 * 60) {
    return null;
  }

  // 找 AO 2 根 K 线
  const c1 = candles15m.find((c) => c.time === aoStart1Utc);
  const c2 = candles15m.find((c) => c.time === aoStart2Utc);
  if (!c1 || !c2) return null;

  const asiaOpenHigh = Math.max(c1.high, c2.high);
  const asiaOpenLow = Math.min(c1.low, c2.low);
  const currentPrice = c2.close;

  // 范围 K 线（0:00-7:45 北京）
  const rangeCandles = candles15m.filter(
    (c) => c.time >= rangeStartUtc && c.time < rangeEndUtc
  );
  if (rangeCandles.length === 0) return null;

  const rangeHigh = Math.max(...rangeCandles.map((c) => c.high));
  const rangeLow = Math.min(...rangeCandles.map((c) => c.low));
  const rangeEQ = (rangeHigh + rangeLow) / 2;

  // 判定
  const inPremium = currentPrice >= rangeEQ;
  let direction: AsiaBiasDirection;

  if (inPremium) {
    // Premium: 期望 AO 向上破 H；破 = LONG，未破 = SHORT
    direction = asiaOpenHigh > rangeHigh ? "long" : "short";
  } else {
    // Discount: 期望 AO 向下破 L；破 = SHORT，未破 = LONG
    direction = asiaOpenLow < rangeLow ? "short" : "long";
  }

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
    computedAt: nowMs,
  };
}
