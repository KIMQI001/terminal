/**
 * Europe Open Bias — 欧盘 Judas 反向判定
 *
 * 概念：欧盘通常是 Asia 方向的 Judas Swing（反向假突破）
 * - 15:30-16:00 北京 = 2 根 15m K-line（7:30 UTC + 7:45 UTC）
 * - 如果 Asia 是 SHORT（看空），但欧盘 30min 的 L 没破当日 L
 *   → Judas 失败 → 反向 → LONG
 * - 如果 Asia 是 LONG（看多），但欧盘 30min 的 H 没破当日 H
 *   → Judas 失败 → 反向 → SHORT
 * - 否则（欧盘成功突破）→ 跟随 Asia 方向
 *
 * 注意：使用 7:30-8:00 UTC 假设夏令时（London BST = UTC+1，3-10 月）。
 * 冬令时（GMT）下应为 8:00-8:30 UTC，但实际数据差异不大，可忽略。
 */

import { Candle } from "@/types/chart";
import { AsiaBiasData } from "@/lib/chart/indicators/asiaBias";

export type EuropeBiasDirection = "long" | "short";

export interface EuropeBiasData {
  direction: EuropeBiasDirection;
  /** Europe Open 30min 的 high */
  europeOpenHigh: number;
  /** Europe Open 30min 的 low */
  europeOpenLow: number;
  /** Europe Open 起始时间（UTC 秒） */
  europeOpenTime: number;
  /** 当日 0:00-15:30 北京 所有 K 线的最高 */
  prevTodayHigh: number;
  /** 当日 0:00-15:30 北京 所有 K 线的最低 */
  prevTodayLow: number;
  /** Asia Open 方向（用于解释） */
  asiaDirection: "long" | "short";
  /** 是否触发 Judas 翻转（true = 反向，false = 跟随 Asia） */
  judasFlipped: boolean;
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
  asiaBias: AsiaBiasData | null,
  nowMs: number = Date.now()
): EuropeBiasData | null {
  if (candles15m.length < 2) return null;
  if (!asiaBias) return null; // 需要 Asia Open 先定调

  const now = new Date(nowMs);
  const beijingMidnightUtc = beijingMidnightUtcSec(now);

  // Europe Open Window: 15:30-16:00 北京 = 2 根 15m K-line
  //   - 15:30-15:45 北京 = 15m K-line at 7:30 UTC
  //   - 15:45-16:00 北京 = 15m K-line at 7:45 UTC
  const europeOpenStartUtc1 = beijingMidnightUtc + 15 * 3600 + 30 * 60; // 7:30 UTC
  const europeOpenStartUtc2 = beijingMidnightUtc + 15 * 3600 + 45 * 60; // 7:45 UTC
  const prevTodayStartUtc = beijingMidnightUtc; // 0:00 北京 = 16:00 UTC
  const prevTodayEndUtc = europeOpenStartUtc1; // 15:30 北京（不含）

  // 16:00 北京之前 → 30min 窗口还没结束
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec < europeOpenStartUtc2 + 15 * 60) {
    return null;
  }

  // 找 2 根 Europe Open 15m K-line
  const c1 = candles15m.find((c) => c.time === europeOpenStartUtc1);
  const c2 = candles15m.find((c) => c.time === europeOpenStartUtc2);
  if (!c1 || !c2) return null;

  const europeOpenHigh = Math.max(c1.high, c2.high);
  const europeOpenLow = Math.min(c1.low, c2.low);

  // 当日 0:00-15:30 北京 之前的 15m K 线（约 62 根）
  const prevTodayCandles = candles15m.filter(
    (c) => c.time >= prevTodayStartUtc && c.time < prevTodayEndUtc
  );
  if (prevTodayCandles.length === 0) return null;

  const prevTodayHigh = Math.max(...prevTodayCandles.map((c) => c.high));
  const prevTodayLow = Math.min(...prevTodayCandles.map((c) => c.low));

  // Judas 反向判定
  let direction: EuropeBiasDirection;
  let judasFlipped: boolean;

  if (asiaBias.direction === "short") {
    // Asia 看空，期望欧盘下行失败（Judas 失败 → 反向 long）
    if (europeOpenLow > prevTodayLow) {
      direction = "long";
      judasFlipped = true;
    } else {
      direction = "short";
      judasFlipped = false;
    }
  } else {
    // Asia 看多，期望欧盘上行失败（Judas 失败 → 反向 short）
    if (europeOpenHigh < prevTodayHigh) {
      direction = "short";
      judasFlipped = true;
    } else {
      direction = "long";
      judasFlipped = false;
    }
  }

  return {
    direction,
    europeOpenHigh,
    europeOpenLow,
    europeOpenTime: europeOpenStartUtc1,
    prevTodayHigh,
    prevTodayLow,
    asiaDirection: asiaBias.direction,
    judasFlipped,
    computedAt: nowMs,
  };
}
