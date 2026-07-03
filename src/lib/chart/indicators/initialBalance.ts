/**
 * Initial Balance (IB) vs PDH/PDL — Always In 检测
 *
 * 时段：北京时间 21:00-22:00（NY 开盘前后 1 小时，夏令时 9-10 AM EST）
 *       = UTC 13:00-14:00
 *
 * 规则：
 * - IB.high > PDH（前一日最高）→ Always In LONG（强势上破）
 * - IB.low  < PDL（前一日最低）→ Always In SHORT（强势下破）
 * - 同时上破下破 → WAIT（罕见，说明昨日 range 被完全吞没，等后续）
 * - 都不破       → WAIT（在 PDH/PDL 之内，继续 Accumulation）
 *
 * 数据需求：
 * - 最近一根 UTC 13:00 开始的 1h K 线（IB 时段）
 * - 昨日 1d K 线的 high / low（PDH/PDL）
 */

import { Candle } from "@/types/chart";

export type AlwaysInDirection = "long" | "short" | "wait";

export interface InitialBalanceData {
  direction: AlwaysInDirection;
  ibHigh: number;
  ibLow: number;
  ibMid: number;
  pdh: number;
  pdl: number;
  /** IB candle 起始时间（UTC 秒） */
  ibTime: number;
  /** PDH/PDL 对应的日 K 起始时间（UTC 秒） */
  pdTime: number;
  /** 计算时间（毫秒） */
  computedAt: number;
}

/**
 * 找最近一根已完成的 13:00 UTC 起始的 1h K 线
 *
 * @param hourlyCandles 按时间升序的 1h K 线
 * @param nowSec 当前 UTC 秒（默认 Date.now() / 1000）
 * @returns 找到的 IB candle，找不到返回 null
 */
export function findIBCandle(
  hourlyCandles: Candle[],
  nowSec: number = Math.floor(Date.now() / 1000)
): Candle | null {
  if (hourlyCandles.length === 0) return null;

  // 今天的 13:00 UTC；如果当前时间还没过 14:00 UTC，用昨天
  const todayMidnightUtc = nowSec - (nowSec % 86400);
  let ibUtcTime = todayMidnightUtc + 13 * 3600; // 13:00 UTC
  if (nowSec < ibUtcTime + 3600) {
    // 今天的 IB 还没结束（< 14:00 UTC），用昨天的
    ibUtcTime -= 86400;
  }

  // 找时间刚好等于 ibUtcTime 的 candle
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
 * 找最近一根已完成的 1d K 线（即"昨日"）
 *
 * @param dailyCandles 按时间升序的 1d K 线
 * @param nowSec 当前 UTC 秒
 * @returns 找到的 PD candle（其 high/low = PDH/PDL）
 */
export function findPDCandle(
  dailyCandles: Candle[],
  nowSec: number = Math.floor(Date.now() / 1000)
): Candle | null {
  if (dailyCandles.length === 0) return null;

  // 今天的 00:00 UTC
  const todayMidnightUtc = nowSec - (nowSec % 86400);

  // 找最近一根 time < todayMidnightUtc 的日 K
  for (let i = dailyCandles.length - 1; i >= 0; i--) {
    if (dailyCandles[i].time < todayMidnightUtc) {
      return dailyCandles[i];
    }
  }

  // 如果今天还没有完整日 K，fallback 到最后一根
  return dailyCandles[dailyCandles.length - 1];
}

/**
 * 核心判定：IB vs PDH/PDL → Always In 方向
 */
export function detectAlwaysIn(
  ibHigh: number,
  ibLow: number,
  pdh: number,
  pdl: number
): AlwaysInDirection {
  const breaksPdh = ibHigh > pdh;
  const breaksPdl = ibLow < pdl;

  if (breaksPdh && !breaksPdl) return "long";
  if (breaksPdl && !breaksPdh) return "short";
  // 双破（完全吞没 PD range）或都不破 → wait
  return "wait";
}

/**
 * 一站式：从 K 线数据算出 InitialBalanceData
 */
export function computeInitialBalance(
  hourlyCandles: Candle[],
  dailyCandles: Candle[],
  nowMs: number = Date.now()
): InitialBalanceData | null {
  const nowSec = Math.floor(nowMs / 1000);

  const ibCandle = findIBCandle(hourlyCandles, nowSec);
  const pdCandle = findPDCandle(dailyCandles, nowSec);
  if (!ibCandle || !pdCandle) return null;

  const direction = detectAlwaysIn(ibCandle.high, ibCandle.low, pdCandle.high, pdCandle.low);

  return {
    direction,
    ibHigh: ibCandle.high,
    ibLow: ibCandle.low,
    ibMid: (ibCandle.high + ibCandle.low) / 2,
    pdh: pdCandle.high,
    pdl: pdCandle.low,
    ibTime: ibCandle.time,
    pdTime: pdCandle.time,
    computedAt: nowMs,
  };
}
