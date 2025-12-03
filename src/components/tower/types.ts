export interface TowerBlock {
  id: string;
  type: "bullish" | "bearish";
  source: "FVG" | "OB" | "OTE";
  timeframe: string;
  high: number;
  low: number;
  entry: number; // fib22 or fib675
  stopLoss: number; // boundary or ±200 points
  takeProfit: number; // opposite block or ±1000 points
  riskReward: number;
  fillPercent: number;
}
