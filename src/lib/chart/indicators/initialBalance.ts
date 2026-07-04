/**
 * Always In — Premium/Discount 判定（用 Europe zone 作参考）
 *
 * 时段：
 *   - Europe Zone = 15:00-20:00 北京 = 7:00-12:00 UTC of "today" (Beijing)
 *     作为参考 H/L/EQ
 *   - IB 窗口 = 21:00-22:00 北京 = 13:00-14:00 UTC
 *
 * 算法：
 *   1. 找 IB 1h K 线（13:00 UTC）
 *   2. 找 Europe zone 15m K 线范围（7:00-12:00 UTC），算 H/L/EQ
 *   3. 判定 IB close 在 Europe Premium 还是 Discount
 *   4. 应用规则：
 *      - Premium (close >= europeEQ): IB H 破 europe H → LONG，否则 SHORT
 *      - Discount (close < europeEQ):  IB L 破 europe L → SHORT，否则 LONG
 *
 * 不用 0:00-21:00 全日范围的原因：全日范围夹杂 pre-Asia + Asia + Europe pre-open，
 * 用 Europe session H/L 更聚焦、Premium/Discount 概念更有意义。
 */

import { Candle } from "@/types/chart";

export type AlwaysInDirection = "long" | "short";

export interface InitialBalanceData {
  direction: AlwaysInDirection;
  /** IB 1h K 线的 high（21:00-22:00 北京） */
  ibHigh: number;
  /** IB 1h K 线的 low */
  ibLow: number;
  /** IB K 线起始时间（UTC 秒） */
  ibTime: number;
  /** Europe Zone 范围 H (15:00-20:00 北京) */
  europeHigh: number;
  /** Europe Zone 范围 L */
  europeLow: number;
  /** Europe Zone EQ = (europeHigh + europeLow) / 2 */
  europeEQ: number;
  /** IB K 线的 close */
  currentPrice: number;
  /** currentPrice >= europeEQ */
  inPremium: boolean;
  /** 计算时间（毫秒） */
  computedAt: number;
}

/**
 * 找最近一根已完成的 13:00 UTC 起始的 1h K 线
 */
export function findIBCandle(
  hourlyCandles: Candle[],
  nowSec: number = Math.floor(Date.now() / 1000)
): Candle | null {
  if (hourlyCandles.length === 0) return null;

  const todayMidnightUtc = nowSec - (nowSec % 86400);
  let ibUtcTime = todayMidnightUtc + 13 * 3600; // 13:00 UTC
  if (nowSec < ibUtcTime + 3600) {
    // 今天的 IB 还没结束（< 14:00 UTC），用昨天的
    ibUtcTime -= 86400;
  }

  for (const c of hourlyCandles) {
    if (c.time === ibUtcTime) return c;
  }

  // 兜底：找最近的、time <= ibUtcTime 的 candle
  let fallback: Candle | null = null;
  for (const c of hourlyCandles) {
    if (c.time > ibUtcTime) break;
    fallback = c;
  }
  return fallback;
}

/**
 * 找 Europe Zone 范围 (7:00-12:00 UTC of "today" = 15:00-20:00 北京) 的 H/L
 *
 * @param fifteenMinCandles 按时间升序的 15m K 线
 * @param nowSec 当前 UTC 秒
 * @returns { high, low } 或 null
 */
export function findEuropeZoneHL(
  fifteenMinCandles: Candle[],
  nowSec: number = Math.floor(Date.now() / 1000)
): { high: number; low: number; anchorTime: number } | null {
  const todayMidnightUtc = nowSec - (nowSec % 86400);
  const europeStart = todayMidnightUtc + 7 * 3600; // 7:00 UTC = 15:00 北京
  const europeEnd = todayMidnightUtc + 12 * 3600; // 12:00 UTC = 20:00 北京

  const europeCandles = fifteenMinCandles.filter(
    (c) => c.time >= europeStart && c.time < europeEnd
  );
  if (europeCandles.length === 0) return null;

  const high = Math.max(...europeCandles.map((c) => c.high));
  const low = Math.min(...europeCandles.map((c) => c.low));

  return { high, low, anchorTime: europeStart };
}

/**
 * 一站式：从 K 线数据算出 InitialBalanceData
 */
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

  let direction: AlwaysInDirection;
  if (inPremium) {
    // Premium: 期望 IB 向上破 Europe H；破 = LONG，未破 = SHORT
    direction = ibCandle.high > europeZone.high ? "long" : "short";
  } else {
    // Discount: 期望 IB 向下破 Europe L；破 = SHORT，未破 = LONG
    direction = ibCandle.low < europeZone.low ? "short" : "long";
  }

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
    computedAt: nowMs,
  };
}
