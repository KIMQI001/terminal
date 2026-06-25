/**
 * 15m ICT 塔块类型定义
 * 与前端 src/lib/chart/indicators/ 算法保持一致
 */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface SwingPoint {
  type: 'high' | 'low';
  price: number;
  time: number;
  index: number;
}

export interface FVG {
  type: 'bullish' | 'bearish';
  high: number;
  low: number;
  time: number;
  filled: boolean;
  fillPercentage: number;
  fib22: number;  // 入场点
}

export interface OrderBlock {
  type: 'bullish' | 'bearish';
  high: number;
  low: number;
  startTime: number;
  mitigated: boolean;
  fillPercentage: number;
  fib22: number;
}

export interface OTEZone {
  type: 'bullish' | 'bearish';
  startTime: number;
  swingHigh: number;
  swingLow: number;
  fib618: number;
  fib786: number;
  fib675: number;
  active: boolean;
}

/**
 * 统一对外的塔块格式
 * 与 towerBlocksFetcher.ts::TowerBlock 一致
 */
export interface TowerBlock {
  id: string;
  type: 'bullish' | 'bearish';
  source: 'FVG' | 'OB' | 'OTE';
  timeframe: '15m';
  high: number;
  low: number;
  entry: number;
  fillPercent: number;
}

export interface DetectionResult {
  symbol: string;
  timeframe: '15m';
  currentPrice: number;
  blocks: TowerBlock[];
  raw: {
    fvgs: FVG[];
    orderBlocks: OrderBlock[];
    oteZones: OTEZone[];
    swingPoints: SwingPoint[];
  };
  timestamp: string;
}
