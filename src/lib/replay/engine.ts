import type { Candle } from "@/types/chart";
import type {
  ReplayConfig,
  ReplayEngineState,
  ReplayExitReason,
  ReplayFill,
  ReplayOrder,
  ReplayPosition,
  ReplaySide,
  ReplaySnapshot,
  ReplayTrade,
} from "./types";

/**
 * 回放撮合引擎（纯函数，无 React / 无 store 依赖）
 *
 * 时序铁律：
 *  - 在游标 c 下的新单，最早可成交 bar = c + 1（这一根已经走完了，下一根才生效）
 *  - 同一根 K 内 SL 与 TP 都触及 → SL 优先（保守）
 *  - 跳空不给优惠：跳空越过 SL 按开盘价止损，跳空越过 TP 按 TP 价止盈
 *  - 限价单成交价一律 = 限价本身（不给跳空成交优惠）
 */

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/** 单调递增的全局 id（不依赖 Date.now，避免同毫秒冲突） */
export function resetIdCounter(): void {
  idCounter = 0;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function createInitialState(config: ReplayConfig): ReplayEngineState {
  const initialCapital = config.initialCapital;
  return {
    account: {
      initialCapital,
      balance: initialCapital,
      cashFree: initialCapital,
      frozenMargin: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      equity: initialCapital,
      marginUsagePct: 0,
      markPrice: 0,
      maxEquity: initialCapital,
      maxDrawdownPct: 0,
    },
    orders: [],
    positions: [],
    trades: [],
    fills: [],
    equityCurve: [],
    snapshots: {},
    seq: 0,
    frontier: -1,
  };
}

function cloneState(s: ReplayEngineState): ReplayEngineState {
  return {
    account: { ...s.account },
    orders: s.orders.map((o) => ({ ...o })),
    positions: s.positions.map((p) => ({ ...p })),
    trades: s.trades.map((t) => ({ ...t })),
    fills: s.fills.map((f) => ({ ...f })),
    equityCurve: s.equityCurve.map((e) => ({ ...e })),
    snapshots: { ...s.snapshots },
    seq: s.seq,
    frontier: s.frontier,
  };
}

/** 用标记价重算浮动盈亏 / 权益 / 回撤 */
export function recomputeAccount(state: ReplayEngineState, markPrice: number): void {
  const acct = state.account;
  acct.markPrice = markPrice;

  let unrealized = 0;
  for (const p of state.positions) {
    unrealized += p.side === "buy" ? (markPrice - p.entryPrice) * p.quantity : (p.entryPrice - markPrice) * p.quantity;
  }
  acct.unrealizedPnl = unrealized;
  acct.cashFree = acct.balance - acct.frozenMargin;
  acct.equity = acct.balance + unrealized;
  acct.marginUsagePct = acct.equity > 0 ? (acct.frozenMargin / acct.equity) * 100 : 0;

  if (acct.equity > acct.maxEquity) acct.maxEquity = acct.equity;
  if (acct.maxEquity > 0) {
    const dd = ((acct.maxEquity - acct.equity) / acct.maxEquity) * 100;
    if (dd > acct.maxDrawdownPct) acct.maxDrawdownPct = dd;
  }
}

/** 更新所有持仓的 MAE / MFE（本根 K 的最不利 / 最有利偏移） */
function updateExcursion(state: ReplayEngineState, bar: Candle): void {
  for (const p of state.positions) {
    if (p.side === "buy") {
      p.mae = Math.max(p.mae, (p.entryPrice - bar.low) * p.quantity);
      p.mfe = Math.max(p.mfe, (bar.high - p.entryPrice) * p.quantity);
    } else {
      p.mae = Math.max(p.mae, (bar.high - p.entryPrice) * p.quantity);
      p.mfe = Math.max(p.mfe, (p.entryPrice - bar.low) * p.quantity);
    }
  }
}

function pushFill(
  state: ReplayEngineState,
  fill: Omit<ReplayFill, "id">
): void {
  state.fills.push({ id: nextId("fill"), ...fill });
}

function openPosition(
  state: ReplayEngineState,
  order: ReplayOrder,
  price: number,
  bar: Candle,
  barIndex: number
): ReplayPosition {
  const margin = (order.quantity * price) / order.leverage;
  const riskAmount = order.stopLoss != null ? Math.abs(price - order.stopLoss) * order.quantity : 0;
  state.seq += 1;
  const position: ReplayPosition = {
    id: nextId("pos"),
    orderId: order.id,
    side: order.side,
    quantity: order.quantity,
    entryPrice: price,
    entryTime: bar.time,
    entryBar: barIndex,
    stopLoss: order.stopLoss,
    takeProfit: order.takeProfit,
    leverage: order.leverage,
    margin,
    riskAmount,
    mae: 0,
    mfe: 0,
    seq: state.seq,
  };
  state.positions.push(position);
  state.account.frozenMargin += margin;
  // 记录成交产生的持仓 id，便于按持仓反查原始订单
  order.positionId = position.id;
  pushFill(state, {
    kind: "entry",
    side: order.side,
    price,
    quantity: order.quantity,
    time: bar.time,
    bar: barIndex,
    tradeSeq: position.seq,
  });
  return position;
}

function closePosition(
  state: ReplayEngineState,
  position: ReplayPosition,
  price: number,
  bar: Candle,
  barIndex: number,
  reason: ReplayExitReason
): void {
  const pnl =
    position.side === "buy"
      ? (price - position.entryPrice) * position.quantity
      : (position.entryPrice - price) * position.quantity;

  state.account.balance += pnl;
  state.account.realizedPnl += pnl;
  state.account.frozenMargin = Math.max(0, state.account.frozenMargin - position.margin);

  const trade: ReplayTrade = {
    seq: position.seq,
    positionId: position.id,
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    entryTime: position.entryTime,
    entryBar: position.entryBar,
    exitPrice: price,
    exitTime: bar.time,
    exitBar: barIndex,
    exitReason: reason,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    margin: position.margin,
    riskAmount: position.riskAmount,
    pnl,
    pnlPct: position.margin > 0 ? (pnl / position.margin) * 100 : 0,
    rMultiple: position.riskAmount > 0 ? pnl / position.riskAmount : 0,
    mae: position.mae,
    mfe: position.mfe,
  };
  state.trades.push(trade);
  pushFill(state, {
    kind: "exit",
    side: position.side,
    price,
    quantity: position.quantity,
    time: bar.time,
    bar: barIndex,
    reason: reason ?? undefined,
    tradeSeq: trade.seq,
  });

  state.positions = state.positions.filter((p) => p.id !== position.id);
}

// ============================================================================
// 下单
// ============================================================================

export interface PlaceOrderInput {
  side: ReplaySide;
  type: "market" | "limit";
  price?: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  /** 平仓单 */
  reduceOnly?: boolean;
  positionId?: string;
}

export interface PlaceOrderResult {
  ok: boolean;
  error?: string;
  order?: ReplayOrder;
}

/** 下单校验 + 生成挂单（不立即成交） */
export function placeOrder(
  state: ReplayEngineState,
  input: PlaceOrderInput,
  cfg: ReplayConfig,
  cursor: number,
  currentPrice: number
): PlaceOrderResult {
  // 平仓单（数量取持仓的，数量可传 0）
  if (input.reduceOnly) {
    const pos = state.positions.find((p) => p.id === input.positionId);
    if (!pos) return { ok: false, error: "持仓不存在" };
    const order: ReplayOrder = {
      id: nextId("ord"),
      side: pos.side,
      type: input.type,
      price: input.price ?? currentPrice,
      quantity: pos.quantity,
      stopLoss: undefined,
      takeProfit: undefined,
      leverage: pos.leverage,
      reduceOnly: true,
      positionId: pos.id,
      status: "pending",
      placedAtBar: cursor,
      eligibleFromBar: cursor + 1,
    };
    state.orders.push(order);
    return { ok: true, order };
  }

  // 开仓单
  if (!(input.quantity > 0)) return { ok: false, error: "数量必须大于 0" };
  const isBuy = input.side === "buy";
  const refPrice = currentPrice;
  const entryPrice = input.type === "limit" ? input.price ?? refPrice : refPrice;

  if (input.type === "limit") {
    if (!(entryPrice > 0)) return { ok: false, error: "限价必须大于 0" };
    if (isBuy && entryPrice >= refPrice) {
      return { ok: false, error: `限价买单价(${entryPrice})必须低于现价(${refPrice})` };
    }
    if (!isBuy && entryPrice <= refPrice) {
      return { ok: false, error: `限价卖单价(${entryPrice})必须高于现价(${refPrice})` };
    }
  }

  const sl = input.stopLoss;
  const tp = input.takeProfit;
  if (sl != null && tp != null) {
    if (isBuy && !(sl < entryPrice && entryPrice < tp)) {
      return { ok: false, error: "多单必须满足 止损 < 入场 < 止盈" };
    }
    if (!isBuy && !(sl > entryPrice && entryPrice > tp)) {
      return { ok: false, error: "空单必须满足 止损 > 入场 > 止盈" };
    }
  } else if (sl != null) {
    if (isBuy && sl >= entryPrice) return { ok: false, error: "多单止损必须低于入场价" };
    if (!isBuy && sl <= entryPrice) return { ok: false, error: "空单止损必须高于入场价" };
  } else if (tp != null) {
    if (isBuy && tp <= entryPrice) return { ok: false, error: "多单止盈必须高于入场价" };
    if (!isBuy && tp >= entryPrice) return { ok: false, error: "空单止盈必须低于入场价" };
  }

  if (state.positions.length >= cfg.maxPositions) {
    return { ok: false, error: `同时持仓数已达上限(${cfg.maxPositions})` };
  }

  const margin = (input.quantity * entryPrice) / cfg.leverage;
  if (margin > state.account.cashFree) {
    return { ok: false, error: `可用资金不足：需要 ${margin.toFixed(2)}，可用 ${state.account.cashFree.toFixed(2)}` };
  }

  const order: ReplayOrder = {
    id: nextId("ord"),
    side: input.side,
    type: input.type,
    price: entryPrice,
    quantity: input.quantity,
    stopLoss: sl,
    takeProfit: tp,
    leverage: cfg.leverage,
    reduceOnly: false,
    status: "pending",
    placedAtBar: cursor,
    eligibleFromBar: cursor + 1,
  };
  state.orders.push(order);
  return { ok: true, order };
}

/** 撤销挂单 */
export function cancelOrder(state: ReplayEngineState, orderId: string, barIndex: number, reason = "manual"): boolean {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || order.status !== "pending") return false;
  order.status = "cancelled";
  order.cancelledAtBar = barIndex;
  order.cancelReason = reason;
  return true;
}

/** 结束回放：撤销全部挂单 */
export function cancelAllOrders(state: ReplayEngineState, barIndex: number, reason = "end"): void {
  for (const o of state.orders) {
    if (o.status === "pending") {
      o.status = "cancelled";
      o.cancelledAtBar = barIndex;
      o.cancelReason = reason;
    }
  }
}

// ============================================================================
// 撮合
// ============================================================================

/**
 * 撮合一根 K 线。
 * @param barIndex 该 K 在回放窗口内的下标（0 基）
 */
export function simulateBar(
  prev: ReplayEngineState,
  bar: Candle,
  barIndex: number,
  cfg: ReplayConfig
): ReplayEngineState {
  const state = cloneState(prev);

  // ---- 0) 更新已有持仓的 MAE / MFE ----
  updateExcursion(state, bar);

  const preexistingIds = new Set(state.positions.map((p) => p.id));

  // ---- Phase A：开盘 ----
  // A1. 成交市价单
  for (const order of state.orders) {
    if (order.status !== "pending" || order.type !== "market") continue;
    if (order.eligibleFromBar > barIndex) continue;

    if (order.reduceOnly) {
      const pos = state.positions.find((p) => p.id === order.positionId);
      if (!pos) {
        order.status = "cancelled";
        order.cancelledAtBar = barIndex;
        order.cancelReason = "position_closed";
        continue;
      }
      order.status = "filled";
      order.filledAtBar = barIndex;
      order.filledPrice = bar.open;
      order.filledTime = bar.time;
      closePosition(state, pos, bar.open, bar, barIndex, "manual");
    } else {
      if (state.positions.length >= cfg.maxPositions) {
        order.status = "cancelled";
        order.cancelledAtBar = barIndex;
        order.cancelReason = "position_limit";
        continue;
      }
      order.status = "filled";
      order.filledAtBar = barIndex;
      order.filledPrice = bar.open;
      order.filledTime = bar.time;
      openPosition(state, order, bar.open, bar, barIndex);
    }
  }

  // A2. 对「本根之前就存在」的持仓做跳空 SL/TP 判定
  for (const pos of [...state.positions]) {
    if (!preexistingIds.has(pos.id)) continue;
    const hit = gapExit(pos, bar);
    if (hit) {
      closePosition(state, pos, hit.price, bar, barIndex, hit.reason);
    }
  }

  // ---- Phase B：区间 ----
  // B0. 新开的持仓也纳入本根的 MAE / MFE
  updateExcursion(state, bar);

  // B1. 成交限价单（触及即成交，成交价 = 限价）
  for (const order of state.orders) {
    if (order.status !== "pending" || order.type !== "limit") continue;
    if (order.eligibleFromBar > barIndex) continue;

    const touched = order.side === "buy" ? bar.low <= order.price : bar.high >= order.price;
    if (!touched) continue;

    if (order.reduceOnly) {
      const pos = state.positions.find((p) => p.id === order.positionId);
      if (!pos) {
        order.status = "cancelled";
        order.cancelledAtBar = barIndex;
        order.cancelReason = "position_closed";
        continue;
      }
      order.status = "filled";
      order.filledAtBar = barIndex;
      order.filledPrice = order.price;
      order.filledTime = bar.time;
      closePosition(state, pos, order.price, bar, barIndex, "manual");
    } else {
      if (state.positions.length >= cfg.maxPositions) {
        order.status = "cancelled";
        order.cancelledAtBar = barIndex;
        order.cancelReason = "position_limit";
        continue;
      }
      order.status = "filled";
      order.filledAtBar = barIndex;
      order.filledPrice = order.price;
      order.filledTime = bar.time;
      openPosition(state, order, order.price, bar, barIndex);
    }
  }

  // B2. 区间 SL/TP（SL 优先）
  for (const pos of [...state.positions]) {
    const hit = rangeExit(pos, bar);
    if (hit) {
      closePosition(state, pos, hit.price, bar, barIndex, hit.reason);
    }
  }

  // ---- Phase C：收盘 ----
  recomputeAccount(state, bar.close);
  state.equityCurve.push({
    bar: barIndex,
    time: bar.time,
    equity: state.account.equity,
    drawdownPct: state.account.maxDrawdownPct,
  });

  const snapshot: ReplaySnapshot = {
    balance: state.account.balance,
    frozenMargin: state.account.frozenMargin,
    realizedPnl: state.account.realizedPnl,
    unrealizedPnl: state.account.unrealizedPnl,
    equity: state.account.equity,
    maxEquity: state.account.maxEquity,
    maxDrawdownPct: state.account.maxDrawdownPct,
    positions: state.positions.map((p) => ({ ...p })),
  };
  state.snapshots[barIndex] = snapshot;
  state.frontier = barIndex;

  return state;
}

/** 跳空判定：开盘就越过 SL / TP */
function gapExit(
  pos: ReplayPosition,
  bar: Candle
): { price: number; reason: ReplayExitReason } | null {
  const sl = pos.stopLoss;
  const tp = pos.takeProfit;
  if (pos.side === "buy") {
    if (sl != null && bar.open <= sl) return { price: bar.open, reason: "sl" };
    if (tp != null && bar.open >= tp) return { price: tp, reason: "tp" };
  } else {
    if (sl != null && bar.open >= sl) return { price: bar.open, reason: "sl" };
    if (tp != null && bar.open <= tp) return { price: tp, reason: "tp" };
  }
  return null;
}

/** 区间判定：K 内触及 SL / TP（SL 优先） */
function rangeExit(
  pos: ReplayPosition,
  bar: Candle
): { price: number; reason: ReplayExitReason } | null {
  const sl = pos.stopLoss;
  const tp = pos.takeProfit;
  if (pos.side === "buy") {
    if (sl != null && bar.low <= sl) return { price: sl, reason: "sl" };
    if (tp != null && bar.high >= tp) return { price: tp, reason: "tp" };
  } else {
    if (sl != null && bar.high >= sl) return { price: sl, reason: "sl" };
    if (tp != null && bar.low <= tp) return { price: tp, reason: "tp" };
  }
  return null;
}

// ============================================================================
// 结束回放
// ============================================================================

/** 结束回放：撤销挂单 + 剩余持仓按指定价强平 */
export function finalizeState(
  prev: ReplayEngineState,
  price: number,
  barIndex: number,
  barTime: number
): ReplayEngineState {
  const state = cloneState(prev);
  cancelAllOrders(state, barIndex, "end");

  const bar: Candle = { time: barTime, open: price, high: price, low: price, close: price };
  for (const pos of [...state.positions]) {
    closePosition(state, pos, price, bar, barIndex, "end");
  }
  recomputeAccount(state, price);
  return state;
}
