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
  name: "asian" | "london" | "ny-am" | "ny-pm";
  startHour: number;
  endHour: number;
  color: string;
}

export interface IndicatorState {
  swingPoints: boolean;
  engulfingPinbar: boolean;
  orderBlocks: boolean;
  fvg: boolean;
  bos: boolean;
  choch: boolean;
  liquidityZones: boolean;
  killzones: boolean;
  ote: boolean;
  breakerBlocks: boolean;
  inducement: boolean;
}
