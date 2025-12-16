/**
 * AI 托管配置存储
 * 简化版：只需要开关和保证金
 */

import { getDatabase } from '../db';

export interface AIManagementConfig {
  id: number;
  userId: number;
  symbol: string;
  isActive: boolean;
  baseMargin: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 初始化 AI 托管表
 */
export function initAIManagementTables(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_management (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      base_margin REAL DEFAULT 100,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, symbol)
    )
  `);

  console.log('[AIManagement] 数据库表已初始化');
}

/**
 * 获取用户的托管配置
 */
export function getAIManagement(userId: number, symbol: string): AIManagementConfig | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT * FROM ai_management WHERE user_id = ? AND symbol = ?
  `).get(userId, symbol) as {
    id: number;
    user_id: number;
    symbol: string;
    is_active: number;
    base_margin: number;
    created_at: string;
    updated_at: string;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    isActive: row.is_active === 1,
    baseMargin: row.base_margin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 获取所有激活的托管配置
 */
export function getActiveAIManagements(symbol?: string): AIManagementConfig[] {
  const db = getDatabase();

  let query = `SELECT * FROM ai_management WHERE is_active = 1`;
  const params: string[] = [];

  if (symbol) {
    query += ` AND symbol = ?`;
    params.push(symbol);
  }

  const rows = db.prepare(query).all(...params) as Array<{
    id: number;
    user_id: number;
    symbol: string;
    is_active: number;
    base_margin: number;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    isActive: row.is_active === 1,
    baseMargin: row.base_margin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * 启动托管
 */
export function startAIManagement(
  userId: number,
  symbol: string,
  baseMargin: number
): AIManagementConfig {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ai_management (user_id, symbol, is_active, base_margin, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(user_id, symbol) DO UPDATE SET
      is_active = 1,
      base_margin = excluded.base_margin,
      updated_at = excluded.updated_at
  `).run(userId, symbol, baseMargin, now, now);

  console.log(`[AIManagement] 用户 ${userId} 启动托管: ${symbol}, 保证金=${baseMargin}`);

  return getAIManagement(userId, symbol)!;
}

/**
 * 停止托管
 */
export function stopAIManagement(userId: number, symbol: string): AIManagementConfig | null {
  const db = getDatabase();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE ai_management
    SET is_active = 0, updated_at = ?
    WHERE user_id = ? AND symbol = ?
  `).run(now, userId, symbol);

  if (result.changes === 0) {
    return null;
  }

  console.log(`[AIManagement] 用户 ${userId} 停止托管: ${symbol}`);

  return getAIManagement(userId, symbol);
}
