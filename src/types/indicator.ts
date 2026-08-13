import { SwingPoint } from "./chart";

export interface OrderBlock {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  startTime: number;
  endTime?: number;
  mitigated: boolean;
  strength: number;
  breakTime?: number;  // 被突破变成 breaker 的时间
  fillPercentage: number;  // 最大填充深度 (0-100)
  fib22: number;           // 0.22 入场点
}

export interface FVG {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  time: number;
  filled: boolean;
  fillPercentage: number;
  fib22: number;  // 0.22入场点
}

/**
 * 拒绝 K 线(Rejection Candle)
 * - 看涨(bullish):长下影 + 小实体 + 短上影 — 价格被低位拒绝,可能反弹
 * - 看跌(bearish):长上影 + 小实体 + 短下影 — 价格被高位拒绝,可能回落
 *
 * 字段说明:
 * - high/low:wick 区域(包含主体一端 + 长影线)的上下界
 * - mid:wick 区域中线 =(high+low)/2,用作 ray 线的 y
 * - wickSize:长影线长度(看涨=bodyTop-candle.low,看跌=candle.high-bodyBottom)
 * - bodySize:实体大小
 * - wickBodyRatio:wick/body 比例,衡量拒绝强度
 */
export interface Rejection {
  type: "bullish" | "bearish";
  time: number;
  index: number;
  high: number;
  low: number;
  mid: number;
  wickSize: number;
  bodySize: number;
  wickBodyRatio: number;
  candleHigh: number;
  candleLow: number;
}

export interface BOS {
  type: "bullish" | "bearish";
  level: number;
  time: number;
  swingPoint: SwingPoint;
}

export interface CHoCH {
  type: "bullish" | "bearish";
  level: number;
  time: number;
  previousTrend: "up" | "down";
}

export interface LiquidityZone {
  type: "buy-side" | "sell-side";
  level: number;
  strength: number;
  swept: boolean;
  times: number[];
}

export interface Killzone {
  name: string;
  startHour: number;  // UTC hour from today's UTC midnight, endHour > 24 means cross-midnight
  endHour: number;
  color: string;
}

export interface IndicatorState {
  swingPoints: boolean;
  orderBlocks: boolean;
  fvg: boolean;
  bos: boolean;
  choch: boolean;
  liquidityZones: boolean;
  killzones: boolean;
  ote: boolean;
  breakerBlocks: boolean;
  inducement: boolean;
  equilibrium: boolean;
  rejections: boolean;
}
