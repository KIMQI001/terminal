/**
 * 待处理订单存储模块
 * 用于存储入场单信息，成交后下止盈止损单
 */

import { getDatabase } from '../db';

// 待处理入场订单
export interface PendingEntryOrder {
  id: number;
  clientOrderId: string;      // ict_tower_4h_OB_95000
  symbol: string;             // BTCUSDC
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  status: 'pending' | 'filled' | 'sl_tp_placed' | 'trailing' | 'closed' | 'canceled' | 'error';
  createdAt: string;
  filledAt: string | null;
  filledPrice: number | null;
  slOrderId: string | null;
  tpOrderId: string | null;
  errorMessage: string | null;
  // 追踪止盈字段
  trailingActive: boolean;
  trailingHighPrice: number | null;  // 多单最高价 / 空单最低价
  trailingActivatedAt: string | null;
  // 平仓相关字段（战绩统计用）
  closedAt: string | null;
  closePrice: number | null;
  closeReason: 'sl' | 'tp' | 'trailing' | 'manual' | null;
  pnlAmount: number | null;      // 盈亏金额 (USDT)
  pnlPercent: number | null;     // 盈亏百分比
  actualRR: number | null;       // 实际盈亏比
}

// 数据库行格式
interface PendingOrderRow {
  id: number;
  client_order_id: string;
  symbol: string;
  side: string;
  position_side: string;
  quantity: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  status: string;
  created_at: string;
  filled_at: string | null;
  filled_price: number | null;
  sl_order_id: string | null;
  tp_order_id: string | null;
  error_message: string | null;
  // 追踪止盈字段
  trailing_active: number;
  trailing_high_price: number | null;
  trailing_activated_at: string | null;
  // 平仓相关字段
  closed_at: string | null;
  close_price: number | null;
  close_reason: string | null;
  pnl_amount: number | null;
  pnl_percent: number | null;
  actual_rr: number | null;
}

/**
 * 初始化待处理订单表
 */
export function initPendingOrdersTable(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_entry_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_order_id TEXT UNIQUE NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
      position_side TEXT NOT NULL CHECK(position_side IN ('LONG', 'SHORT')),
      quantity REAL NOT NULL,
      entry_price REAL NOT NULL,
      stop_loss REAL NOT NULL,
      take_profit REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'filled', 'sl_tp_placed', 'trailing', 'closed', 'canceled', 'error')),
      created_at TEXT NOT NULL,
      filled_at TEXT,
      filled_price REAL,
      sl_order_id TEXT,
      tp_order_id TEXT,
      error_message TEXT,
      trailing_active INTEGER NOT NULL DEFAULT 0,
      trailing_high_price REAL,
      trailing_activated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pending_orders_status ON pending_entry_orders(status);
    CREATE INDEX IF NOT EXISTS idx_pending_orders_client_id ON pending_entry_orders(client_order_id);
    CREATE INDEX IF NOT EXISTS idx_pending_orders_symbol ON pending_entry_orders(symbol);
  `);

  // 迁移：为旧表添加追踪止盈字段
  try {
    db.exec(`ALTER TABLE pending_entry_orders ADD COLUMN trailing_active INTEGER NOT NULL DEFAULT 0`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE pending_entry_orders ADD COLUMN trailing_high_price REAL`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE pending_entry_orders ADD COLUMN trailing_activated_at TEXT`);
  } catch { /* 列已存在 */ }

  // 迁移：为旧表添加平仓相关字段（战绩统计用）
  try {
    db.exec(`ALTER TABLE pending_entry_orders ADD COLUMN closed_at TEXT`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE pending_entry_orders ADD COLUMN close_price REAL`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE pending_entry_orders ADD COLUMN close_reason TEXT`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE pending_entry_orders ADD COLUMN pnl_amount REAL`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE pending_entry_orders ADD COLUMN pnl_percent REAL`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE pending_entry_orders ADD COLUMN actual_rr REAL`);
  } catch { /* 列已存在 */ }

  console.log('[PendingOrderStore] 表初始化完成');
}

/**
 * 添加待处理订单
 */
export function addPendingOrder(order: {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO pending_entry_orders
    (client_order_id, symbol, side, position_side, quantity, entry_price, stop_loss, take_profit, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  const result = stmt.run(
    order.clientOrderId,
    order.symbol,
    order.side,
    order.positionSide,
    order.quantity,
    order.entryPrice,
    order.stopLoss,
    order.takeProfit,
    new Date().toISOString()
  );

  console.log(`[PendingOrderStore] 添加待处理订单: ${order.clientOrderId}`);
  return result.lastInsertRowid as number;
}

/**
 * 获取待处理订单（按 clientOrderId）
 */
export function getPendingOrderByClientId(clientOrderId: string): PendingEntryOrder | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT * FROM pending_entry_orders WHERE client_order_id = ?
  `).get(clientOrderId) as PendingOrderRow | undefined;

  if (!row) return null;

  return rowToOrder(row);
}

/**
 * 获取所有待处理订单
 */
export function getAllPendingOrders(): PendingEntryOrder[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT * FROM pending_entry_orders WHERE status = 'pending' ORDER BY created_at DESC
  `).all() as PendingOrderRow[];

  return rows.map(rowToOrder);
}

/**
 * 获取指定状态的订单
 */
export function getOrdersByStatus(status: PendingEntryOrder['status']): PendingEntryOrder[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT * FROM pending_entry_orders WHERE status = ? ORDER BY created_at DESC
  `).all(status) as PendingOrderRow[];

  return rows.map(rowToOrder);
}

/**
 * 更新订单状态为已成交
 */
export function markOrderFilled(clientOrderId: string, filledPrice: number): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE pending_entry_orders
    SET status = 'filled', filled_at = ?, filled_price = ?
    WHERE client_order_id = ?
  `).run(new Date().toISOString(), filledPrice, clientOrderId);

  console.log(`[PendingOrderStore] 订单已成交: ${clientOrderId} @ ${filledPrice}`);
}

/**
 * 更新订单状态为止盈止损已下单
 */
export function markSlTpPlaced(
  clientOrderId: string,
  slOrderId: string | null,
  tpOrderId: string | null
): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE pending_entry_orders
    SET status = 'sl_tp_placed', sl_order_id = ?, tp_order_id = ?
    WHERE client_order_id = ?
  `).run(slOrderId, tpOrderId, clientOrderId);

  console.log(`[PendingOrderStore] 止盈止损已下单: ${clientOrderId}, SL=${slOrderId}, TP=${tpOrderId}`);
}

/**
 * 更新订单状态为已取消
 */
export function markOrderCanceled(clientOrderId: string): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE pending_entry_orders
    SET status = 'canceled'
    WHERE client_order_id = ?
  `).run(clientOrderId);

  console.log(`[PendingOrderStore] 订单已取消: ${clientOrderId}`);
}

/**
 * 更新订单状态为错误
 */
export function markOrderError(clientOrderId: string, errorMessage: string): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE pending_entry_orders
    SET status = 'error', error_message = ?
    WHERE client_order_id = ?
  `).run(errorMessage, clientOrderId);

  console.error(`[PendingOrderStore] 订单错误: ${clientOrderId} - ${errorMessage}`);
}

/**
 * 删除订单
 */
export function deletePendingOrder(clientOrderId: string): boolean {
  const db = getDatabase();

  const result = db.prepare(`
    DELETE FROM pending_entry_orders WHERE client_order_id = ?
  `).run(clientOrderId);

  return result.changes > 0;
}

/**
 * 清理过期订单 (24小时前的 pending 订单)
 */
export function cleanupOldPendingOrders(): number {
  const db = getDatabase();

  const result = db.prepare(`
    DELETE FROM pending_entry_orders
    WHERE status = 'pending'
    AND datetime(created_at) < datetime('now', '-24 hours')
  `).run();

  if (result.changes > 0) {
    console.log(`[PendingOrderStore] 清理了 ${result.changes} 个过期订单`);
  }

  return result.changes;
}

/**
 * 获取订单统计
 */
export function getOrderStats(): {
  pending: number;
  filled: number;
  slTpPlaced: number;
  canceled: number;
  error: number;
} {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM pending_entry_orders GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const stats = {
    pending: 0,
    filled: 0,
    slTpPlaced: 0,
    canceled: 0,
    error: 0,
  };

  for (const row of rows) {
    switch (row.status) {
      case 'pending':
        stats.pending = row.count;
        break;
      case 'filled':
        stats.filled = row.count;
        break;
      case 'sl_tp_placed':
        stats.slTpPlaced = row.count;
        break;
      case 'canceled':
        stats.canceled = row.count;
        break;
      case 'error':
        stats.error = row.count;
        break;
    }
  }

  return stats;
}

/**
 * 将数据库行转换为订单对象
 */
function rowToOrder(row: PendingOrderRow): PendingEntryOrder {
  return {
    id: row.id,
    clientOrderId: row.client_order_id,
    symbol: row.symbol,
    side: row.side as 'BUY' | 'SELL',
    positionSide: row.position_side as 'LONG' | 'SHORT',
    quantity: row.quantity,
    entryPrice: row.entry_price,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    status: row.status as PendingEntryOrder['status'],
    createdAt: row.created_at,
    filledAt: row.filled_at,
    filledPrice: row.filled_price,
    slOrderId: row.sl_order_id,
    tpOrderId: row.tp_order_id,
    errorMessage: row.error_message,
    trailingActive: row.trailing_active === 1,
    trailingHighPrice: row.trailing_high_price,
    trailingActivatedAt: row.trailing_activated_at,
    // 平仓相关字段
    closedAt: row.closed_at,
    closePrice: row.close_price,
    closeReason: row.close_reason as PendingEntryOrder['closeReason'],
    pnlAmount: row.pnl_amount,
    pnlPercent: row.pnl_percent,
    actualRR: row.actual_rr,
  };
}

/**
 * 获取需要追踪止盈的订单（已成交且止盈止损已下单）
 */
export function getOrdersForTrailing(): PendingEntryOrder[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT * FROM pending_entry_orders
    WHERE status IN ('sl_tp_placed', 'trailing')
    ORDER BY created_at DESC
  `).all() as PendingOrderRow[];

  return rows.map(rowToOrder);
}

/**
 * 激活追踪止盈
 */
export function activateTrailing(clientOrderId: string, highPrice: number): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE pending_entry_orders
    SET status = 'trailing', trailing_active = 1, trailing_high_price = ?, trailing_activated_at = ?
    WHERE client_order_id = ?
  `).run(highPrice, now, clientOrderId);

  console.log(`[PendingOrderStore] 追踪止盈已激活: ${clientOrderId}, 最高价=${highPrice}`);
}

/**
 * 更新追踪最高价/最低价
 */
export function updateTrailingHighPrice(clientOrderId: string, highPrice: number): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE pending_entry_orders
    SET trailing_high_price = ?
    WHERE client_order_id = ?
  `).run(highPrice, clientOrderId);
}

/**
 * 标记订单已平仓（简单版，不含盈亏数据）
 */
export function markOrderClosed(clientOrderId: string): void {
  const db = getDatabase();

  db.prepare(`
    UPDATE pending_entry_orders
    SET status = 'closed'
    WHERE client_order_id = ?
  `).run(clientOrderId);

  console.log(`[PendingOrderStore] 订单已平仓: ${clientOrderId}`);
}

/**
 * 标记订单已平仓并记录盈亏数据（战绩统计用）
 */
export function markOrderClosedWithPnL(
  clientOrderId: string,
  data: {
    closePrice: number;
    closeReason: 'sl' | 'tp' | 'trailing' | 'manual';
    pnlAmount: number;
    pnlPercent: number;
    actualRR: number;
  }
): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE pending_entry_orders
    SET status = 'closed',
        closed_at = ?,
        close_price = ?,
        close_reason = ?,
        pnl_amount = ?,
        pnl_percent = ?,
        actual_rr = ?
    WHERE client_order_id = ?
  `).run(
    now,
    data.closePrice,
    data.closeReason,
    data.pnlAmount,
    data.pnlPercent,
    data.actualRR,
    clientOrderId
  );

  const emoji = data.pnlAmount >= 0 ? '✅' : '❌';
  console.log(`[PendingOrderStore] ${emoji} 订单平仓: ${clientOrderId}, ${data.closeReason.toUpperCase()}, 盈亏: ${data.pnlAmount >= 0 ? '+' : ''}${data.pnlAmount.toFixed(2)} USDT (${data.pnlPercent.toFixed(2)}%)`);
}

/**
 * 获取已平仓的订单（用于战绩统计）
 */
export function getClosedOrders(options?: {
  symbol?: string;
  limit?: number;
  days?: number;
}): PendingEntryOrder[] {
  const db = getDatabase();

  let query = `SELECT * FROM pending_entry_orders WHERE status = 'closed' AND close_price IS NOT NULL`;
  const params: (string | number)[] = [];

  if (options?.symbol) {
    query += ` AND symbol = ?`;
    params.push(options.symbol);
  }

  if (options?.days && options.days > 0) {
    query += ` AND datetime(closed_at) >= datetime('now', ?)`;
    params.push(`-${options.days} days`);
  }

  query += ` ORDER BY closed_at DESC`;

  if (options?.limit) {
    query += ` LIMIT ?`;
    params.push(options.limit);
  }

  const rows = db.prepare(query).all(...params) as PendingOrderRow[];
  return rows.map(rowToOrder);
}

/**
 * 获取战绩统计
 */
export function getPerformanceStats(options?: {
  symbol?: string;
  days?: number;
}): {
  totalOrders: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnl: number;
  avgWinAmount: number;
  avgLossAmount: number;
  largestWin: number;
  largestLoss: number;
  avgRR: number;
  profitFactor: number;
  byCloseReason: { sl: number; tp: number; trailing: number; manual: number };
} {
  const orders = getClosedOrders(options);

  const wins = orders.filter(o => (o.pnlAmount ?? 0) > 0);
  const losses = orders.filter(o => (o.pnlAmount ?? 0) < 0);

  const winAmounts = wins.map(o => o.pnlAmount ?? 0);
  const lossAmounts = losses.map(o => Math.abs(o.pnlAmount ?? 0));

  const totalWin = winAmounts.reduce((a, b) => a + b, 0);
  const totalLoss = lossAmounts.reduce((a, b) => a + b, 0);

  const winRate = orders.length > 0 ? wins.length / orders.length : 0;
  const avgWin = wins.length > 0 ? totalWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;

  // 计算平均盈亏比
  const rrValues = orders.filter(o => o.actualRR !== null).map(o => o.actualRR!);
  const avgRR = rrValues.length > 0 ? rrValues.reduce((a, b) => a + b, 0) / rrValues.length : 0;

  return {
    totalOrders: orders.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate,
    totalPnl: totalWin - totalLoss,
    avgWinAmount: avgWin,
    avgLossAmount: avgLoss,
    largestWin: Math.max(...winAmounts, 0),
    largestLoss: Math.max(...lossAmounts, 0),
    avgRR,
    profitFactor: totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? Infinity : 0),
    byCloseReason: {
      sl: orders.filter(o => o.closeReason === 'sl').length,
      tp: orders.filter(o => o.closeReason === 'tp').length,
      trailing: orders.filter(o => o.closeReason === 'trailing').length,
      manual: orders.filter(o => o.closeReason === 'manual').length,
    },
  };
}
