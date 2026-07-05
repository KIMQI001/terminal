/**
 * Europe Open Window Bias — Premium/Discount 判定
 *
 * 改用 Asia 时段（8:00-14:00 北京）的 H/L 作为参考：
 *
 * 1. Asia Zone = 8:00-14:00 北京 = 00:00-06:00 UTC of "today" (Beijing)
 *    - asiaHigh, asiaLow, asiaEQ = 范围内的 H/L/中点
 * 2. EO 2 根 15m K-line (15:30-16:00 北京) close 决定当前价位置
 * 3. 应用规则：
 *    - Premium (close >= asiaEQ): EO H 破 asia H → LONG，否则 SHORT
 *    - Discount (close < asiaEQ): EO L 破 asia L → SHORT，否则 LONG
 *
 * 不用 0:00-15:30 全日范围的原因：全日范围夹杂 pre-Asian 和 gap，
 * 用 Asia session 的 H/L 更聚焦、Premium/Discount 概念更有意义。
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
  /** Asia Zone 范围 H (8:00-14:00 北京) */
  asiaHigh: number;
  /** Asia Zone 范围 L */
  asiaLow: number;
  /** Asia Zone 范围 EQ = (asiaHigh + asiaLow) / 2 */
  asiaEQ: number;
  /** EO 第 2 根 K 线的 close */
  currentPrice: number;
  /** currentPrice >= asiaEQ */
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

  // Asia Zone: 8:00-14:00 北京 = 0:00-6:00 UTC of "today" (Beijing)
  // beijingMidnightUtc = 0:00 北京 = 16:00 UTC 前一天
  // 0:00 UTC 当天 = 8:00 北京 = beijingMidnightUtc + 8h
  const asiaStartUtc = beijingMidnightUtc + 8 * 3600;  // 8:00 北京
  const asiaEndUtc   = beijingMidnightUtc + 14 * 3600; // 14:00 北京

  // EO 2 根 15m K-line: 15:30-15:45 + 15:45-16:00 北京
  const eoStart1Utc = beijingMidnightUtc + 7 * 3600 + 30 * 60; // 7:30 UTC = 15:30 北京
  const eoStart2Utc = beijingMidnightUtc + 7 * 3600 + 45 * 60; // 7:45 UTC = 15:45 北京

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

  // Asia Zone K 线（8:00-14:00 北京 = 00:00-06:00 UTC）
  const asiaCandles = candles15m.filter(
    (c) => c.time >= asiaStartUtc && c.time < asiaEndUtc
  );
  if (asiaCandles.length === 0) return null;

  const asiaHigh = Math.max(...asiaCandles.map((c) => c.high));
  const asiaLow = Math.min(...asiaCandles.map((c) => c.low));
  const asiaEQ = (asiaHigh + asiaLow) / 2;

  // 判定
  const inPremium = currentPrice >= asiaEQ;
  let direction: EuropeBiasDirection;

  if (inPremium) {
    // Premium: 期望 EO 向上破 Asia H；破 = LONG，未破 = SHORT
    direction = europeOpenHigh > asiaHigh ? "long" : "short";
  } else {
    // Discount: 期望 EO 向下破 Asia L；破 = SHORT，未破 = LONG
    direction = europeOpenLow < asiaLow ? "short" : "long";
  }

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
    computedAt: nowMs,
  };
}
