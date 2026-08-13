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
 * Rejection Zone(供给/需求区)
 * - bullish(下影/支撑):level 是下影中点,zone = [low, bodyBottom]
 * - bearish(上影/阻力):level 是上影中点,zone = [bodyTop, high]
 *
 * 字段说明:
 * - level:wick 段中点(用作 ray 线 y)
 * - zoneHigh/zoneLow:wick 段上下界
 * - wickSize:影线长度
 * - ratio:wick 占整 K range 的比例(>= 0.4 触发检测)
 * - candleHigh/candleLow:来源 K 线的 high/low(供 zone 计算)
 */
export interface Rejection {
  type: "bullish" | "bearish";
  time: number;
  index: number;
  level: number;
  zoneHigh: number;
  zoneLow: number;
  wickSize: number;
  ratio: number;
  candleHigh: number;
  candleLow: number;
  /** 层级:R1/R2/... 或 S1/S2/... — 看上一个 wick 类型,同方向 +1,不同方向 reset 到 1 */
  tier: number;
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
