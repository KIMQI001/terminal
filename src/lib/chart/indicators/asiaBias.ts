/**
 * Asia Open Window Bias — 亚洲开盘窗口方向
 *
 * 概念：
 * - 7:30-8:00 北京 (≈ 23:30-00:30 UTC 1h K 线) 是 Asia Session Open Window
 * - 如果这根 K 线的 high > 当日 0:00-7:30 北京 之前所有 K 线的最高价
 *   → 强势突破当日新高 → 看多
 * - 否则 → 看空
 *
 * 用 1h K 线近似（"7:30-8:30 北京" 这根 1h K 线），
 * 30min 误差可接受，与现有 IB 窗口（21:00-22:00 北京）逻辑一致。
 */

import { Candle } from "@/types/chart";

export type AsiaBiasDirection = "long" | "short";

export interface AsiaBiasData {
  direction: AsiaBiasDirection;
  /** Asia Open Window 1h K 线的 high（用于看是否破前高） */
  asiaOpenHigh: number;
  /** Asia Open Window 1h K 线的 low */
  asiaOpenLow: number;
  /** Asia Open Window K 线起始时间（UTC 秒） */
  asiaOpenTime: number;
  /** 当日 0:00-7:30 北京 所有 K 线的最高 */
  prevTodayHigh: number;
  /** 当日 0:00-7:30 北京 所有 K 线的最低 */
  prevTodayLow: number;
  /** 计算时间（毫秒） */
  computedAt: number;
}

/**
 * 把北京时间的日期转成当日 0:00 对应的 UTC 时间戳（秒）
 */
function beijingMidnightUtcSec(date: Date): number {
  // "en-CA" 输出 YYYY-MM-DD
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

  // Asia Open Window 起点：7:30 北京 = beijingMidnight + 7.5h
  const asiaOpenStartUtc = beijingMidnightUtc + 7 * 3600 + 30 * 60; // 7.5h
  const prevTodayStartUtc = beijingMidnightUtc; // 0:00 北京
  const prevTodayEndUtc = asiaOpenStartUtc; // 7:30 北京（不含）

  // 当前时间还没到 8:00 北京 → Asia Open 窗口还没结束，K 线可能不完整
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec < asiaOpenStartUtc + 3600) {
    // 8:00 北京之前的判断逻辑：
    // 如果现在 >= 7:30 北京，已经能看到 1h K 线在形成（但不完全），暂不返回结果
    // 等到 8:00 之后再返回
    return null;
  }

  // 找 Asia Open 1h K 线（time === asiaOpenStartUtc）
  const asiaCandle = hourlyCandles.find((c) => c.time === asiaOpenStartUtc);
  if (!asiaCandle) return null;

  // 当日 0:00-7:30 北京 之前的 K 线
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
