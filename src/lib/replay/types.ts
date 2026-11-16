/**
 * 回放模拟盘 —— 类型定义
 *
 * 引擎层（engine.ts / scoring.ts）与 UI 层（replayStore / components/replay）
 * 以及存档 API（/api/user/replay/*）共用这里的类型。
 */

export type ReplaySide = "buy" | "sell";
export type ReplayOrderType = "market" | "limit";

/** 平仓原因：sl=止损, tp=止盈, manual=手动平仓, end=回放结束强平 */
export type ReplayExitReason = "sl" | "tp" | "manual" | "end" | null;

/** 回放参数（会被 persist 到 localStorage） */
export interface ReplayConfig {
  symbol: string;
  timeframe: string;
  /** 回放根数（最近 N 根） */
  barCount: number;
  /** 虚拟本金（USDT） */
  initialCapital: number;
  /** 固定手数 */
  quantity: number;
  /** 杠杆 */
  leverage: number;
  /** 同时最大持仓数 */
  maxPositions: number;
  /** 单笔风险上限 %（相对权益） */
  maxRiskPerTradePct: number;
  /** 单笔最大亏损 % */
  maxStopLossPct: number;
  /** 保证金占用上限 % */
  maxMarginUsagePct: number;
  /** 最大回撤上限 % */
  maxDrawdownPct: number;
  /** 播放速度（根/秒） */
  speed: number;
}

export const DEFAULT_REPLAY_CONFIG: Omit<ReplayConfig, "symbol" | "timeframe"> = {
  barCount: 300,
  initialCapital: 1000,
  quantity: 0.001,
  leverage: 1,
  maxPositions: 1,
  maxRiskPerTradePct: 2,
  maxStopLossPct: 5,
  maxMarginUsagePct: 50,
  maxDrawdownPct: 15,
  speed: 2,
};

/** 模拟挂单 */
export interface ReplayOrder {
  id: string;
  side: ReplaySide;
  type: ReplayOrderType;
  /** 限价单 = 限价；市价单 = 提交时的参考价（仅展示） */
  price: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage: number;
  /** 平仓单（reduce only） */
  reduceOnly: boolean;
  /** 平仓单关联的持仓 id */
  positionId?: string;
  status: "pending" | "filled" | "cancelled";
  /** 提交时可见的最后一根 K 的窗口内下标 */
  placedAtBar: number;
  /** 最早可成交 bar = placedAtBar + 1（杜绝未来函数） */
  eligibleFromBar: number;
  filledAtBar?: number;
  filledPrice?: number;
  filledTime?: number;
  cancelledAtBar?: number;
  cancelReason?: string;
}

/** 模拟持仓 */
export interface ReplayPosition {
  id: string;
  orderId: string;
  side: ReplaySide;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  entryBar: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage: number;
  /** 冻结保证金 = qty * entry / leverage */
  margin: number;
  /** 风险金额 = |entry - SL| * qty（算 R 用） */
  riskAmount: number;
  /** 最大不利偏移（正数，quote 货币） */
  mae: number;
  /** 最大有利偏移（正数，quote 货币） */
  mfe: number;
  /** 交易序号（与 ReplayTrade.seq 对应） */
  seq: number;
}

/** 一开一平 = 一笔完整交易 */
export interface ReplayTrade {
  seq: number;
  positionId: string;
  side: ReplaySide;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  entryBar: number;
  exitPrice?: number;
  exitTime?: number;
  exitBar?: number;
  exitReason: ReplayExitReason;
  stopLoss?: number;
  takeProfit?: number;
  margin: number;
  riskAmount: number;
  /** 已实现盈亏（quote） */
  pnl: number;
  /** pnl / margin */
  pnlPct: number;
  /** pnl / riskAmount（无止损时为 0） */
  rMultiple: number;
  mae: number;
  mfe: number;
  /** 进场质量分 0-100 */
  entryScore?: number;
  entryDeductions?: ScoreItem[];
  disciplineFlags?: ScoreItem[];
}

/** 成交明细 */
export interface ReplayFill {
  id: string;
  tradeSeq?: number;
  kind: "entry" | "exit";
  side: ReplaySide;
  price: number;
  quantity: number;
  time: number;
  bar: number;
  /** exit 时的原因: sl / tp / manual / end */
  reason?: string;
}

/** 虚拟账户 */
export interface ReplayAccount {
  initialCapital: number;
  /** 余额 = 可用资金 + 冻结保证金（开仓不改变余额） */
  balance: number;
  /** 可用资金 */
  cashFree: number;
  /** 冻结保证金 */
  frozenMargin: number;
  realizedPnl: number;
  unrealizedPnl: number;
  /** 权益 = balance + unrealizedPnl */
  equity: number;
  marginUsagePct: number;
  /** 当前标记价 */
  markPrice: number;
  maxEquity: number;
  maxDrawdownPct: number;
}

export interface EquityPoint {
  bar: number;
  time: number;
  equity: number;
  drawdownPct: number;
}

/** 可追溯的扣分/加分明细 */
export interface ScoreItem {
  label: string;
  /** 正数 = 加分，负数 = 扣分 */
  points: number;
  detail: string;
  /** 关联的交易序号 */
  tradeSeq?: number;
}

export interface ReplayScoreSection {
  key: "profit" | "entry" | "discipline";
  title: string;
  /** 0-100 */
  score: number;
  /** 权重 0.4 / 0.3 / 0.3 */
  weight: number;
  items: ScoreItem[];
}

export interface ReplayScore {
  /** 0-100 */
  total: number;
  /** A+ / A / B / C / D / E */
  grade: string;
  sections: ReplayScoreSection[];
}

/** 每根 K 收盘后的账本快照（用于单步后退时回看视图） */
export interface ReplaySnapshot {
  balance: number;
  frozenMargin: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  maxEquity: number;
  maxDrawdownPct: number;
  positions: ReplayPosition[];
}

/** 引擎状态（纯数据，由 engine 维护） */
export interface ReplayEngineState {
  account: ReplayAccount;
  orders: ReplayOrder[];
  positions: ReplayPosition[];
  trades: ReplayTrade[];
  fills: ReplayFill[];
  equityCurve: EquityPoint[];
  /** 每根 K 的账本快照（key = 窗口内 bar 下标） */
  snapshots: Record<number, ReplaySnapshot>;
  /** 交易序号自增器 */
  seq: number;
  /** 已撮合到的最后一根 bar（真相游标） */
  frontier: number;
}

/** 落库用的整场 payload */
export interface ReplaySessionPayload {
  symbol: string;
  timeframe: string;
  barCount: number;
  barsReplayed: number;
  config: ReplayConfig;
  startedAt: number;
  endedAt: number;
  account: ReplayAccount;
  score: ReplayScore;
  trades: ReplayTrade[];
  equityCurve: EquityPoint[];
}
