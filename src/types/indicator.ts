import { SwingPoint } from "./chart";

export interface OrderBlock {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  startTime: number;
  endTime?: number;
  mitigated: boolean;
  strength: number;
}

export interface FVG {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  time: number;
  filled: boolean;
  fillPercentage: number;
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
  orderBlocks: boolean;
  fvg: boolean;
  bos: boolean;
  choch: boolean;
  liquidityZones: boolean;
  killzones: boolean;
}
