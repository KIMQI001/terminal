/**
 * Asia Open Window Bias — 亚洲开盘窗口方向
 *
 * 概念：
 * - 7:00-8:00 北京 (= 1h K-line at 23:00 UTC) 是 Asia Session Open Window
 * - 用户原意是 7:30-8:00 这个 30min；用 1h K-line 近似（30min 误差可接受）
 * - 如果这根 K 线的 high > 当日 0:00-7:00 北京 之前所有 K 线的最高价
 *   → 强势突破当日新高 → 看多
 * - 否则 → 看空
 */

import { Candle } from "@/types/chart";

export type AsiaBiasDirection = "long" | "short";

export interface AsiaBiasData {
  direction: AsiaBiasDirection;
  /** Asia Open Window 1h K 线的 high */
  asiaOpenHigh: number;
  /** Asia Open Window 1h K 线的 low */
  asiaOpenLow: number;
  /** Asia Open Window K 线起始时间（UTC 秒，1h K-line 在整点） */
  asiaOpenTime: number;
  /** 当日 0:00-7:00 北京 所有 K 线的最高 */
  prevTodayHigh: number;
  /** 当日 0:00-7:00 北京 所有 K 线的最低 */
  prevTodayLow: number;
  /** 计算时间（毫秒） */
  computedAt: number;
}

/**
 * 把"现在"转成"当日北京 0:00"对应的 UTC 时间戳（秒）
 *
 * 0:00 北京 = 16:00 UTC of previous day
 */
function beijingMidnightUtcSec(date: Date): number {
  const beijingDateStr = date.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const [y, m, d] = beijingDateStr.split("-").map(Number);
  // Date.UTC(y, m-1, d) = y-m-d 00:00:00 UTC
  // y-m-d 00:00 北京 = y-m-d 00:00 UTC - 8h
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) - 8 * 3600;
}

/**
 * 计算 Asia Open Window Bias
 *
 * @param hourlyCandles 按时间升序的 1h K 线
 * @param nowMs 当前时间（毫秒），默认 Date.now()
 * @returns AsiaBiasData 或 null（数据未就绪时返回 null）
 */
export function computeAsiaBias(
  hourlyCandles: Candle[],
  nowMs: number = Date.now()
): AsiaBiasData | null {
  if (hourlyCandles.length < 2) return null;

  const now = new Date(nowMs);
  // 当日 0:00 北京 对应的 UTC 时间戳
  const beijingMidnightUtc = beijingMidnightUtcSec(now);

  // Asia Open Window 起点（1h K-line 整点 UTC）
  // 7:00-8:00 北京 = 1h K-line at 23:00 UTC（time 字段是 23:00:00）
  // 起点：beijingMidnight + 7h
  const asiaOpenStartUtc = beijingMidnightUtc + 7 * 3600; // 23:00 UTC of "today" (Beijing)
  const prevTodayStartUtc = beijingMidnightUtc; // 0:00 北京 = 16:00 UTC
  const prevTodayEndUtc = asiaOpenStartUtc; // 7:00 北京（不含）

  // 8:00 北京之前 → Asia Open 1h K 线还没结束
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec < asiaOpenStartUtc + 3600) {
    return null;
  }

  // 找 Asia Open 1h K 线（time === 23:00 UTC）
  const asiaCandle = hourlyCandles.find((c) => c.time === asiaOpenStartUtc);
  if (!asiaCandle) return null;

  // 当日 0:00-7:00 北京 之前的 K 线（16:00-22:59 UTC，共 7 根）
  const prevTodayCandles = hourlyCandles.filter(
    (c) => c.time >= prevTodayStartUtc && c.time < prevTodayEndUtc
  );
  if (prevTodayCandles.length === 0) return null;

  const prevTodayHigh = Math.max(...prevTodayCandles.map((c) => c.high));
  const prevTodayLow = Math.min(...prevTodayCandles.map((c) => c.low));

  // 判定：Asia Open high 破前高 → long；不破 → short
  const direction: AsiaBiasDirection =
    asiaCandle.high > prevTodayHigh ? "long" : "short";

  return {
    direction,
    asiaOpenHigh: asiaCandle.high,
    asiaOpenLow: asiaCandle.low,
    asiaOpenTime: asiaCandle.time,
    prevTodayHigh,
    prevTodayLow,
    computedAt: nowMs,
  };
}
