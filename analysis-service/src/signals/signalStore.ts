/**
 * 信号存储模块
 * 负责信号的 CRUD 操作
 */

import { randomUUID } from 'crypto';
import { getDatabase, SignalRecord, SignalRow, rowToRecord } from '../db';
import { TradeSignal } from '../analysis/aiAnalyzer';

/**
 * 保存交易信号到数据库
 * @returns 信号 ID
 */
export function saveSignal(
  signal: TradeSignal,
  symbol: string,
  timeframe: string
): string {
  const db = getDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO signals (
      id, created_at, symbol, timeframe, direction, confidence,
      entry_price, stop_loss, take_profits, risk_reward, reasoning, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);

  stmt.run(
    id,
    now,
    symbol,
    timeframe,
    signal.direction,
    signal.confidence,
    signal.entry.price,
    signal.stopLoss.price,
    JSON.stringify(signal.takeProfit.map(tp => tp.price)),
    signal.riskReward,
    signal.reasoning
  );

  console.log(`[SignalStore] 信号已保存: ${id} (${symbol}@${timeframe} ${signal.direction})`);
  return id;
}

/**
 * 更新信号状态
 */
export function updateSignalStatus(
  id: string,
  status: SignalRecord['status'],
  updates?: {
    enteredAt?: Date;
    exitedAt?: Date;
    exitPrice?: number;
    exitReason?: string;
    actualRR?: number;
    pnlPercent?: number;
  }
): void {
  const db = getDatabase();

  const setClauses = ['status = ?'];
  const values: (string | number)[] = [status];

  if (updates?.enteredAt) {
    setClauses.push('entered_at = ?');
    values.push(updates.enteredAt.toISOString());
  }
  if (updates?.exitedAt) {
    setClauses.push('exited_at = ?');
    values.push(updates.exitedAt.toISOString());
  }
  if (updates?.exitPrice !== undefined) {
    setClauses.push('exit_price = ?');
    values.push(updates.exitPrice);
  }
  if (updates?.exitReason) {
    setClauses.push('exit_reason = ?');
    values.push(updates.exitReason);
  }
  if (updates?.actualRR !== undefined) {
    setClauses.push('actual_rr = ?');
    values.push(updates.actualRR);
  }
  if (updates?.pnlPercent !== undefined) {
    setClauses.push('pnl_percent = ?');
    values.push(updates.pnlPercent);
  }

  values.push(id);

  const stmt = db.prepare(`
    UPDATE signals SET ${setClauses.join(', ')} WHERE id = ?
  `);

  stmt.run(...values);
  console.log(`[SignalStore] 信号状态更新: ${id} -> ${status}`);
}

/**
 * 获取所有待入场的信号
 */
export function getPendingSignals(): SignalRecord[] {
  const db = getDatabase();
  const stmt = db.prepare<[], SignalRow>(`
    SELECT * FROM signals WHERE status = 'pending' ORDER BY created_at DESC
  `);
  const rows = stmt.all();
  return rows.map(rowToRecord);
}

/**
 * 获取所有已入场的信号
 */
export function getEnteredSignals(): SignalRecord[] {
  const db = getDatabase();
  const stmt = db.prepare<[], SignalRow>(`
    SELECT * FROM signals WHERE status = 'entered' ORDER BY entered_at DESC
  `);
  const rows = stmt.all();
  return rows.map(rowToRecord);
}

/**
 * 获取指定日期范围内的信号
 */
export function getSignalsByDateRange(start: Date, end: Date): SignalRecord[] {
  const db = getDatabase();
  const stmt = db.prepare<[string, string], SignalRow>(`
    SELECT * FROM signals
    WHERE created_at >= ? AND created_at < ?
    ORDER BY created_at DESC
  `);
  const rows = stmt.all(start.toISOString(), end.toISOString());
  return rows.map(rowToRecord);
}

/**
 * 获取已完成的信号（止损或止盈）
 */
export function getCompletedSignals(start?: Date, end?: Date): SignalRecord[] {
  const db = getDatabase();

  let query = `SELECT * FROM signals WHERE status IN ('stopped', 'profit')`;
  const params: string[] = [];

  if (start && end) {
    query += ` AND created_at >= ? AND created_at < ?`;
    params.push(start.toISOString(), end.toISOString());
  }

  query += ` ORDER BY exited_at DESC`;

  const stmt = db.prepare<string[], SignalRow>(query);
  const rows = stmt.all(...params);
  return rows.map(rowToRecord);
}

/**
 * 标记超时的信号为过期
 * @param hoursOld 超过多少小时视为过期（默认24小时）
 */
export function expireOldSignals(hoursOld: number = 24): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - hoursOld * 60 * 60 * 1000).toISOString();

  const stmt = db.prepare(`
    UPDATE signals
    SET status = 'expired', exit_reason = '信号超时过期'
    WHERE status = 'pending' AND created_at < ?
  `);

  const result = stmt.run(cutoff);
  const count = result.changes;

  if (count > 0) {
    console.log(`[SignalStore] ${count} 个信号已标记为过期`);
  }

  return count;
}

/**
 * 获取信号统计摘要
 */
export function getSignalStats(start?: Date, end?: Date): {
  total: number;
  pending: number;
  entered: number;
  stopped: number;
  profit: number;
  expired: number;
} {
  const db = getDatabase();

  let query = `
    SELECT
      status,
      COUNT(*) as count
    FROM signals
  `;
  const params: string[] = [];

  if (start && end) {
    query += ` WHERE created_at >= ? AND created_at < ?`;
    params.push(start.toISOString(), end.toISOString());
  }

  query += ` GROUP BY status`;

  const stmt = db.prepare<string[], { status: string; count: number }>(query);
  const rows = stmt.all(...params);

  const stats = {
    total: 0,
    pending: 0,
    entered: 0,
    stopped: 0,
    profit: 0,
    expired: 0,
  };

  for (const row of rows) {
    stats[row.status as keyof typeof stats] = row.count;
    stats.total += row.count;
  }

  return stats;
}

/**
 * 根据 ID 获取信号
 */
export function getSignalById(id: string): SignalRecord | null {
  const db = getDatabase();
  const stmt = db.prepare<[string], SignalRow>(`
    SELECT * FROM signals WHERE id = ?
  `);
  const row = stmt.get(id);
  return row ? rowToRecord(row) : null;
}

/**
 * 获取某个交易对的最新信号
 */
export function getLatestSignal(symbol: string, timeframe: string): SignalRecord | null {
  const db = getDatabase();
  const stmt = db.prepare<[string, string], SignalRow>(`
    SELECT * FROM signals
    WHERE symbol = ? AND timeframe = ?
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = stmt.get(symbol, timeframe);
  return row ? rowToRecord(row) : null;
}

/**
 * 检查是否存在相同的待处理信号（防止重复）
 */
export function hasDuplicatePendingSignal(
  symbol: string,
  timeframe: string,
  direction: 'long' | 'short',
  entryPrice: number,
  tolerance: number = 0.001 // 0.1% 容差
): boolean {
  const db = getDatabase();

  const minPrice = entryPrice * (1 - tolerance);
  const maxPrice = entryPrice * (1 + tolerance);

  const stmt = db.prepare<[string, string, string, number, number], { count: number }>(`
    SELECT COUNT(*) as count FROM signals
    WHERE symbol = ? AND timeframe = ? AND direction = ?
    AND status IN ('pending', 'entered')
    AND entry_price BETWEEN ? AND ?
  `);

  const row = stmt.get(symbol, timeframe, direction, minPrice, maxPrice);
  return (row?.count ?? 0) > 0;
}
