import { SwingPoint, Candle } from "@/types/chart";

/**
 * Equilibrium (Premium / Discount) — ICT 概念
 *
 * 在最近一对 swing high / swing low 之间画 50% 中线：
 * - 中线之上 = Premium（溢价区，倾向做空）
 * - 中线之下 = Discount（折价区，倾向做多）
 *
 * 用作位置过滤器：在折价区做多、在溢价区做空，质量天然更高。
 */

export type ZoneSide = "premium" | "discount" | "equilibrium";

export interface EquilibriumLevel {
  swingHigh: number;
  swingLow: number;
  swingHighTime: number;
  swingLowTime: number;
  /** swingLow + range * 0.5 */
  equilibrium: number;
  /** swingHigh - swingLow */
  range: number;
  /** (range / swingLow) * 100 — 用于 UI 排序 / 噪声过滤 */
  rangePercent: number;
  premiumZone: { high: number; low: number };
  discountZone: { high: number; low: number };
  startTime: number;
  endTime: number;
  /** 当前价所在区 */
  side: ZoneSide;
  /** (price - eq) / range * 100；正数 = 在 EQ 之上，负数 = 之下 */
  distanceToEQPercent: number;
  /** 范围是否被反向穿越（false = 该 range 已失效，不再显示） */
  valid: boolean;
  /** 0 = 最近一对（主显示），1 = 次近一对（参考） */
  pairIndex: number;
}

/**
 * Detect Equilibrium zones from swing points
 *
 * 算法：
 * 1. swingPoints 按时间 desc 排序
 * 2. 配对 high→low（上涨段）/ low→high（下跌段），与 detectOTEZones 保持一致
 * 3. 算 range、equilibrium、side
 * 4. 用 historicallyFilled 过滤被反向穿越的 range
 * 5. 配对时校验 swingPoint.time < lastCandle.time，排除未完成 swing
 * 6. 返回最近 maxPairs 对
 */
export function detectEquilibriumZones(
  swingPoints: SwingPoint[],
  currentPrice: number,
  candles: Candle[] = [],
  maxPairs: number = 2
): EquilibriumLevel[] {
  const zones: EquilibriumLevel[] = [];

  if (swingPoints.length < 2) return zones;

  // Sort by time desc (newest first) — 与 ote.ts 一致
  const sorted = [...swingPoints].sort((a, b) => b.time - a.time);

  const lastCandleTime = candles.length > 0 ? candles[candles.length - 1].time : Infinity;

  for (let i = 0; i < sorted.length - 1 && zones.length < maxPairs; i++) {
    const current = sorted[i];
    const prev = sorted[i + 1];

    // 排除未完成 swing（时间晚于最后一根 K 线）
    if (current.time > lastCandleTime) continue;

    let swingHigh: number;
    let swingLow: number;
    let swingHighTime: number;
    let swingLowTime: number;

    // 上涨段：current = high, prev = low  →  range 向上
    // 下跌段：current = low, prev = high   →  range 向下
    if (current.type === "high" && prev.type === "low") {
      swingHigh = current.price;
      swingLow = prev.price;
      swingHighTime = current.time;
      swingLowTime = prev.time;
    } else if (current.type === "low" && prev.type === "high") {
      swingHigh = prev.price;
      swingLow = current.price;
      swingHighTime = prev.time;
      swingLowTime = current.time;
    } else {
      continue;
    }

    const range = swingHigh - swingLow;
    if (range <= 0) continue;

    // 噪声过滤：range 占比 < 0.1% 跳过
    const rangePercent = (range / swingLow) * 100;
    if (rangePercent < 0.1) continue;

    // EQ 中点
    const equilibrium = swingLow + range * 0.5;

    // 判定当前价所在区
    const epsilon = range * 0.005; // |price - eq| < 0.5% range 视为 equilibrium
    let side: ZoneSide;
    if (Math.abs(currentPrice - equilibrium) <= epsilon) {
      side = "equilibrium";
    } else if (currentPrice > equilibrium) {
      side = "premium";
    } else {
      side = "discount";
    }

    // 距离 EQ 百分比（用于 UI 排序 / 显示）
    const distanceToEQPercent = ((currentPrice - equilibrium) / range) * 100;

    // 过滤被反向穿越的 range（参考 ote.ts:53-62 模式）
    // 上涨段（sl → sh）后，若有 candle.low <= swingLow 则 range 被跌破 → valid=false
    // 下跌段（sh → sl）后，若有 candle.high >= swingHigh 则 range 被涨破 → valid=false
    let valid = true;
    const breachStart = Math.max(swingHighTime, swingLowTime);
    for (const candle of candles) {
      if (candle.time <= breachStart) continue;
      // 上涨段后的反向穿越
      if (swingHighTime > swingLowTime) {
        if (candle.low <= swingLow) {
          valid = false;
          break;
        }
      } else {
        // 下跌段后的反向穿越
        if (candle.high >= swingHigh) {
          valid = false;
          break;
        }
      }
    }

    zones.push({
      swingHigh,
      swingLow,
      swingHighTime,
      swingLowTime,
      equilibrium,
      range,
      rangePercent,
      premiumZone: { high: swingHigh, low: equilibrium },
      discountZone: { high: equilibrium, low: swingLow },
      startTime: Math.min(swingHighTime, swingLowTime),
      endTime: Math.max(swingHighTime, swingLowTime),
      side,
      distanceToEQPercent,
      valid,
      pairIndex: zones.length,
    });
  }

  return zones;
}
