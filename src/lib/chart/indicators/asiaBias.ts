/**
 * Asia Open Window Bias — 亚洲开盘窗口方向
 *
 * 概念：
 * - 2 根 15m K-line（23:45 UTC + 00:00 UTC）覆盖 7:45-8:15 北京
 * - 如果这 30min 的 high > 当日 0:00-7:45 北京 之前所有 K 线的最高价
 *   → 强势突破当日新高 → 看多
 * - 否则 → 看空
 *
 * 不用 30m K-line（kline-server 未订阅），用 2 根 15m 拼出精确 30min 窗口。
 */

import { Candle } from "@/types/chart";

export type AsiaBiasDirection = "long" | "short";

export interface AsiaBiasData {
  direction: AsiaBiasDirection;
  /** Asia Open Window 30min 的 high（2 根 15m 拼出） */
  asiaOpenHigh: number;
  /** Asia Open Window 30min 的 low */
  asiaOpenLow: number;
  /** Asia Open Window 起始时间（UTC 秒） */
  asiaOpenTime: number;
  /** 当日 0:00-7:45 北京 所有 K 线的最高 */
  prevTodayHigh: number;
  /** 当日 0:00-7:45 北京 所有 K 线的最低 */
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
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) - 8 * 3600;
}

/**
 * 计算 Asia Open Window Bias
 *
 * @param candles15m 按时间升序的 15m K 线
 * @param nowMs 当前时间（毫秒），默认 Date.now()
 * @returns AsiaBiasData 或 null（数据未就绪时返回 null）
 */
export function computeAsiaBias(
  candles15m: Candle[],
  nowMs: number = Date.now()
): AsiaBiasData | null {
  if (candles15m.length < 2) return null;

  const now = new Date(nowMs);
  const beijingMidnightUtc = beijingMidnightUtcSec(now);

  // Asia Open Window: 7:45-8:15 北京 = 2 根 15m K-line
  //   - 7:45-8:00 北京 = 15m K-line at 23:45 UTC（time 字段 = 23:45:00）
  //   - 8:00-8:15 北京 = 15m K-line at 00:00 UTC（time 字段 = 00:00:00，次日）
  const asiaOpenStartUtc1 = beijingMidnightUtc + 7 * 3600 + 45 * 60; // 23:45 UTC
  const asiaOpenStartUtc2 = beijingMidnightUtc + 8 * 3600; // 00:00 UTC (次日的秒)
  const prevTodayStartUtc = beijingMidnightUtc; // 0:00 北京 = 16:00 UTC
  const prevTodayEndUtc = asiaOpenStartUtc1; // 7:45 北京（不含）

  // 8:15 北京之前 → 30min 窗口还没结束
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec < asiaOpenStartUtc2 + 15 * 60) {
    return null;
  }

  // 找 2 根 Asia Open 15m K-line
  const c1 = candles15m.find((c) => c.time === asiaOpenStartUtc1);
  const c2 = candles15m.find((c) => c.time === asiaOpenStartUtc2);
  if (!c1 || !c2) return null;

  // 拼出 30min H/L
  const asiaOpenHigh = Math.max(c1.high, c2.high);
  const asiaOpenLow = Math.min(c1.low, c2.low);

  // 当日 0:00-7:45 北京 之前的 15m K 线（每 15min 一根，共 29 根）
  const prevTodayCandles = candles15m.filter(
    (c) => c.time >= prevTodayStartUtc && c.time < prevTodayEndUtc
  );
  if (prevTodayCandles.length === 0) return null;

  const prevTodayHigh = Math.max(...prevTodayCandles.map((c) => c.high));
  const prevTodayLow = Math.min(...prevTodayCandles.map((c) => c.low));

  // 判定：Asia Open high 破前高 → long；不破 → short
  const direction: AsiaBiasDirection =
    asiaOpenHigh > prevTodayHigh ? "long" : "short";

  return {
    direction,
    asiaOpenHigh,
    asiaOpenLow,
    asiaOpenTime: asiaOpenStartUtc1,
    prevTodayHigh,
    prevTodayLow,
    computedAt: nowMs,
  };
}
