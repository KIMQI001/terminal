export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d" | "4d" | "1w";

export interface ChartConfig {
  symbol: string;
  timeframe: Timeframe;
}

export interface SwingPoint {
  type: "high" | "low";
  price: number;
  time: number;
  index: number;
}
