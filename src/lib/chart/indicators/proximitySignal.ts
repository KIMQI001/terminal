// src/lib/chart/indicators/proximitySignal.ts
//
// 检测器:已收盘 K 的 wick 接近但未触及关键位
// - FVG 三档(fib22/50/90)— 全算,跳过 filled
// - OB 三档(fib22/50/90)— 全算,跳过 mitigated
// - Wick S/R 中点(level)
// 默认 bandUsd = 15(可从 env var NEXT_PUBLIC_PROXIMITY_BAND_USD 覆盖)

import { Candle } from "@/types/chart";
import { ProximitySignal } from "@/types/proximitySignal";

type FibPct = 22 | 50 | 90;
type RejectionKind = "bullish" | "bearish";

interface FvgLite {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  filled?: boolean;
}

interface ObLite {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  mitigated?: boolean;
}

interface RejectionLite {
  type: RejectionKind;
  level: number;
}

const DEFAULT_BAND_USD = 15;

interface KeyPoint {
  level: number;
  zoneType: RejectionKind;
  kind: "fvg" | "ob" | "wick";
  fib?: FibPct;
  wickKind?: "support" | "resistance";
}

/** 构建关键位池 */
function buildKeyPointPool(
  fvgs: FvgLite[],
  orderBlocks: ObLite[],
  rejections: RejectionLite[]
): KeyPoint[] {
  const pool: KeyPoint[] = [];

  // FVG 三档
  for (const fvg of fvgs) {
    if (fvg.filled) continue;
    const size = fvg.high - fvg.low;
    if (size <= 0) continue;
    for (const fibPct of [22, 50, 90] as const) {
      let level = 0;
      if (fvg.type === "bullish") {
        level = fvg.high - size * (fibPct / 100);
      } else {
        level = fvg.low + size * (fibPct / 100);
      }
      pool.push({ level, zoneType: fvg.type, kind: "fvg", fib: fibPct });
    }
  }

  // OB 三档
  for (const ob of orderBlocks) {
    if (ob.mitigated) continue;
    const size = ob.high - ob.low;
    if (size <= 0) continue;
    for (const fibPct of [22, 50, 90] as const) {
      let level = 0;
      if (ob.type === "bullish") {
        level = ob.high - size * (fibPct / 100);
      } else {
        level = ob.low + size * (fibPct / 100);
      }
      pool.push({ level, zoneType: ob.type, kind: "ob", fib: fibPct });
    }
  }

  // Wick S/R 中点
  for (const w of rejections) {
    pool.push({
      level: w.level,
      zoneType: w.type,
      kind: "wick",
      wickKind: w.type === "bullish" ? "support" : "resistance",
    });
  }

  return pool;
}

/** 检测 proximity signals */
export function detectProximitySignals(
  candles: Candle[],
  fvgs: FvgLite[],
  orderBlocks: ObLite[],
  rejections: RejectionLite[],
  bandUsd: number = DEFAULT_BAND_USD
): ProximitySignal[] {
  if (candles.length < 2) return [];

  const pool = buildKeyPointPool(fvgs, orderBlocks, rejections);
  if (pool.length === 0) return [];

  const out: ProximitySignal[] = [];
  const lastIdx = candles.length - 1;  // 跳过最后一根(进行中)

  for (let i = 1; i < lastIdx; i++) {
    const c = candles[i];

    for (const kp of pool) {
      if (kp.zoneType === "bullish") {
        // 支撑:kp.level 在 c.low 上方,距离 = level - low
        const diff = kp.level - c.low;
        if (diff > 0 && diff <= bandUsd) {
          out.push({
            time: c.time,
            side: "bullish",
            level: kp.level,
            kind: kp.kind,
            fib: kp.fib,
            wickKind: kp.wickKind,
            diff,
          });
        }
      } else {
        // 阻力:kp.level 在 c.high 下方,距离 = high - level
        const diff = c.high - kp.level;
        if (diff > 0 && diff <= bandUsd) {
          out.push({
            time: c.time,
            side: "bearish",
            level: kp.level,
            kind: kp.kind,
            fib: kp.fib,
            wickKind: kp.wickKind,
            diff,
          });
        }
      }
    }
  }

  return out;
}

/** 从 env var 读取 bandUsd(默认 15)— 浏览器端需 NEXT_PUBLIC_ 前缀 */
export function getProximityBandUsd(): number {
  const envValue = typeof process !== "undefined"
    ? (process.env?.NEXT_PUBLIC_PROXIMITY_BAND_USD ?? process.env?.PROXIMITY_BAND_USD)
    : undefined;
  if (envValue) {
    const v = parseFloat(envValue);
    if (!isNaN(v) && v > 0) return v;
  }
  return DEFAULT_BAND_USD;
}

/** 触发 proximity signal 的 K 线的颜色(浅紫/深蓝)— 整根 K 染色 */
export const PROXIMITY_KLINE_COLOR = {
  bullish: "rgba(167, 139, 250, 0.8)",   // purple-400 浅紫
  bearish: "rgba(30, 64, 175, 0.8)",      // blue-800 深蓝
} as const;
