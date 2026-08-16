// src/types/proximitySignal.ts
//
// Proximity Signal:已收盘 K 的 wick 接近但未触及关键位。
// 视觉:把触发的 K 线**本身变色**(浅紫/深蓝)— 不画水平线不画背景。

export interface ProximitySignal {
  /** K close time (秒) */
  time: number;
  /** bullish=下影接近支撑, bearish=上影接近阻力 */
  side: "bullish" | "bearish";
  /** 关键位价格 */
  level: number;
  /** 来源类型 */
  kind: "fvg" | "ob" | "wick";
  /** FVG/OB 三档(22/50/90) */
  fib?: 22 | 50 | 90;
  /** Wick 类型(支撑/阻力) */
  wickKind?: "support" | "resistance";
  /** USD 距离(总是正数,≤ bandUsd) */
  diff: number;
}
