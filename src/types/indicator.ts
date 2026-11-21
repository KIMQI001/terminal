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
  fib50: number;           // 0.5 中点
  fib90: number;           // 0.9 入场点
}

export interface FVG {
  type: "bullish" | "bearish";
  high: number;
  low: number;
  time: number;
  filled: boolean;
  fillPercentage: number;
  fib22: number;  // 0.22入场点
  fib50: number;  // 0.5 中点
  fib90: number;  // 0.9 入场点
  /** 中间 K 索引(用于跨过 swing point 算 tier) */
  candleIndex: number;
  /** 层级:FS1/FS2/... 或 FR1/FR2/... — 从最近的 HH(FR)或 LL(FS)开始算段内连续 FVG 数 */
  tier: number;
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
  /** 层级:R1/R2/... 或 S1/S2/... — 看上一个 wick(跨过同根 K),同方向 +1,不同方向 reset 到 1 */
  tier: number;
  /** 检测顺序:K index*2 + (S=0/R=1) — 用于排序保证时序 */
  sequence: number;
}

export interface BOS {
  type: "bullish" | "bearish";
  /** 被突破的结构位价格 */
  level: number;
  /** 突破发生的那根 K 的时间（收盘价越过结构位的那一刻） */
  time: number;
  /** 被突破的那个摆动点 */
  swingPoint: SwingPoint;
}

export interface CHoCH {
  type: "bullish" | "bearish";
  /** 被突破的结构位价格 */
  level: number;
  /** 突破发生的那根 K 的时间（收盘价越过结构位的那一刻） */
  time: number;
  /** 突破前的趋势方向 */
  previousTrend: "up" | "down";
  /** 被突破的那个摆动点 */
  swingPoint: SwingPoint;
}

/**
 * 预测的结构事件 —— 还没发生，但价格一旦**收盘**越过就会变成真的 BOS / CHoCH
 *
 * 渲染层画成**实线**；价格收盘越过后引擎会真的报出事件 → 线变回虚线。
 * 只被影线插破、收盘收回的结构位仍然有效 → 依然会被实线标成「下一个 BOS」。
 */
export interface StructurePrediction {
  /** "bos" = 顺势突破，"choch" = 逆势突破（趋势可能反转） */
  kind: "bos" | "choch";
  /** 方向："bullish" = 向上突破上方结构位，"bearish" = 向下突破下方结构位 */
  direction: "bullish" | "bearish";
  /** 目标结构位价格 */
  level: number;
  /** 目标结构位所在的摆动点（线的起点） */
  swingPoint: SwingPoint;
}

/**
 * 上下两个方向的预测目标
 * - bullish：上方最近的一个未破结构位 → 破它会发生什么
 * - bearish：下方最近的一个未破结构位 → 破它会发生什么
 */
export interface StructureProjection {
  bullish: StructurePrediction | null;
  bearish: StructurePrediction | null;
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
  /** 最新 HH/LL 向左延伸的水平虚射线(LL 亮蓝 / HH 亮橙) */
  swingRays: boolean;
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
  proximitySignals: boolean;
  /** 价格带(Price Band)—— 月K 推导的 5 阻力 + 5 支撑带 */
  priceBand: boolean;
  /** ICT Setup 状态机（流动性→扫荡→位移→回踩 POI→可入场） */
  ictSetup: boolean;
}
