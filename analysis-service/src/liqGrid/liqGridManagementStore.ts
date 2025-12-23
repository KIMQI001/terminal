/**
 * 流动性网格托管状态存储
 * 持久化托管配置和状态到数据库
 */

import { getDatabase } from '../db';

// 交易所类型
export type ExchangeType = 'binance' | 'aster';

// 托管配置
export interface LiqGridManagementConfig {
  id: number;
  userId: number;
  symbol: string;                // 交易对 (ETHUSDC)
  exchange: ExchangeType;        // 交易所 (binance/aster)
  isActive: boolean;             // 是否启用
  intervalMinutes: number;       // 托管间隔（分钟）
  baseMargin: number;            // 基础保证金
  marginPerLevel: number;        // 每层递增保证金
  leverage: number;              // 杠杆倍数
  lastRunAt: string | null;      // 上次执行时间
  nextRunAt: string | null;      // 下次执行时间
  createdAt: string;
  updatedAt: string;
}

// 托管执行记录
export interface LiqGridManagementRecord {
  id: number;
  managementId: number;
  executedAt: string;
  buyCount: number;
  sellCount: number;
  totalMargin: number;
  success: boolean;
  skipped: boolean;
  errorMessage: string | null;
}

// 数据库行格式
interface ManagementRow {
  id: number;
  user_id: number;
  symbol: string;
  exchange: string;
  is_active: number;
  interval_minutes: number;
  base_margin: number;
  margin_per_level: number;
  leverage: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RecordRow {
  id: number;
  management_id: number;
  executed_at: string;
  buy_count: number;
  sell_count: number;
  total_margin: number;
  success: number;
  skipped: number;
  error_message: string | null;
}

/**
 * 初始化托管相关表
 */
export function initLiqGridManagementTables(): void {
  const db = getDatabase();

  db.exec(`
    -- 流动性网格托管配置表
    CREATE TABLE IF NOT EXISTS liq_grid_management (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      base_margin REAL NOT NULL DEFAULT 50,
      margin_per_level REAL NOT NULL DEFAULT 10,
      leverage INTEGER NOT NULL DEFAULT 10,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, symbol)
    );

    -- 流动性网格托管执行记录表
    CREATE TABLE IF NOT EXISTS liq_grid_management_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      management_id INTEGER NOT NULL,
      executed_at TEXT NOT NULL,
      buy_count INTEGER NOT NULL DEFAULT 0,
      sell_count INTEGER NOT NULL DEFAULT 0,
      total_margin REAL NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      skipped INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      FOREIGN KEY (management_id) REFERENCES liq_grid_management(id)
    );

    CREATE INDEX IF NOT EXISTS idx_liq_grid_management_active ON liq_grid_management(is_active);
    CREATE INDEX IF NOT EXISTS idx_liq_grid_management_user ON liq_grid_management(user_id);
    CREATE INDEX IF NOT EXISTS idx_liq_grid_records_management ON liq_grid_management_records(management_id);
  `);

  // 迁移：添加 exchange 字段
  try {
    db.exec(`ALTER TABLE liq_grid_management ADD COLUMN exchange TEXT NOT NULL DEFAULT 'binance'`);
    console.log('[LiqGridManagement] 添加 exchange 字段');
  } catch { /* 列已存在 */ }

  console.log('[LiqGridManagement] 表初始化完成');
}

/**
 * 获取用户的托管配置
 */
export function getManagement(userId: number, symbol: string): LiqGridManagementConfig | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT * FROM liq_grid_management WHERE user_id = ? AND symbol = ?
  `).get(userId, symbol) as ManagementRow | undefined;

  if (!row) return null;
  return rowToConfig(row);
}

/**
 * 获取所有活跃的托管配置
 */
export function getActiveManagements(): LiqGridManagementConfig[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT * FROM liq_grid_management WHERE is_active = 1
  `).all() as ManagementRow[];

  return rows.map(rowToConfig);
}

/**
 * 创建或更新托管配置
 */
export function upsertManagement(config: {
  userId: number;
  symbol: string;
  exchange?: ExchangeType;
  isActive: boolean;
  intervalMinutes: number;
  baseMargin: number;
  marginPerLevel: number;
  leverage: number;
}): LiqGridManagementConfig {
  const exchange = config.exchange || 'binance';
  const db = getDatabase();
  const now = new Date().toISOString();

  // 如果激活，立即执行第一次（设置 nextRunAt 为当前时间）
  const nextRunAt = config.isActive ? now : null;

  const existing = getManagement(config.userId, config.symbol);

  if (existing) {
    // 更新
    db.prepare(`
      UPDATE liq_grid_management SET
        exchange = ?,
        is_active = ?,
        interval_minutes = ?,
        base_margin = ?,
        margin_per_level = ?,
        leverage = ?,
        next_run_at = ?,
        updated_at = ?
      WHERE user_id = ? AND symbol = ?
    `).run(
      exchange,
      config.isActive ? 1 : 0,
      config.intervalMinutes,
      config.baseMargin,
      config.marginPerLevel,
      config.leverage,
      nextRunAt,
      now,
      config.userId,
      config.symbol
    );

    console.log(`[LiqGridManagement] 更新托管配置: userId=${config.userId}, symbol=${config.symbol}, exchange=${exchange}, active=${config.isActive}`);
  } else {
    // 创建
    db.prepare(`
      INSERT INTO liq_grid_management (
        user_id, symbol, exchange, is_active, interval_minutes, base_margin, margin_per_level,
        leverage, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.userId,
      config.symbol,
      exchange,
      config.isActive ? 1 : 0,
      config.intervalMinutes,
      config.baseMargin,
      config.marginPerLevel,
      config.leverage,
      nextRunAt,
      now,
      now
    );

    console.log(`[LiqGridManagement] 创建托管配置: userId=${config.userId}, symbol=${config.symbol}, exchange=${exchange}`);
  }

  return getManagement(config.userId, config.symbol)!;
}

/**
 * 停止托管
 */
export function stopManagement(userId: number, symbol: string): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE liq_grid_management SET
      is_active = 0,
      next_run_at = NULL,
      updated_at = ?
    WHERE user_id = ? AND symbol = ?
  `).run(now, userId, symbol);

  if (result.changes > 0) {
    console.log(`[LiqGridManagement] 停止托管: userId=${userId}, symbol=${symbol}`);
    return true;
  }
  return false;
}

/**
 * 更新执行时间
 */
export function updateRunTime(managementId: number): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  // 获取当前配置以计算下次执行时间
  const config = db.prepare(`
    SELECT interval_minutes FROM liq_grid_management WHERE id = ?
  `).get(managementId) as { interval_minutes: number } | undefined;

  if (!config) return;

  const nextRunAt = new Date(Date.now() + config.interval_minutes * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE liq_grid_management SET
      last_run_at = ?,
      next_run_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(now, nextRunAt, now, managementId);
}

/**
 * 添加执行记录
 */
export function addRecord(record: {
  managementId: number;
  buyCount: number;
  sellCount: number;
  totalMargin: number;
  success: boolean;
  skipped: boolean;
  errorMessage?: string;
}): number {
  const db = getDatabase();
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO liq_grid_management_records (
      management_id, executed_at, buy_count, sell_count, total_margin,
      success, skipped, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.managementId,
    now,
    record.buyCount,
    record.sellCount,
    record.totalMargin,
    record.success ? 1 : 0,
    record.skipped ? 1 : 0,
    record.errorMessage || null
  );

  return result.lastInsertRowid as number;
}

/**
 * 获取最近的执行记录
 */
export function getRecentRecords(managementId: number, limit = 20): LiqGridManagementRecord[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT * FROM liq_grid_management_records
    WHERE management_id = ?
    ORDER BY executed_at DESC
    LIMIT ?
  `).all(managementId, limit) as RecordRow[];

  return rows.map(row => ({
    id: row.id,
    managementId: row.management_id,
    executedAt: row.executed_at,
    buyCount: row.buy_count,
    sellCount: row.sell_count,
    totalMargin: row.total_margin,
    success: row.success === 1,
    skipped: row.skipped === 1,
    errorMessage: row.error_message,
  }));
}

/**
 * 获取统计信息
 */
export function getManagementStats(managementId: number): {
  totalExecutions: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
} {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN success = 1 AND skipped = 0 THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) as skipped
    FROM liq_grid_management_records
    WHERE management_id = ?
  `).get(managementId) as { total: number | null; success: number | null; failed: number | null; skipped: number | null } | undefined;

  return {
    totalExecutions: row?.total || 0,
    successCount: row?.success || 0,
    failedCount: row?.failed || 0,
    skippedCount: row?.skipped || 0,
  };
}

/**
 * 清理过期记录（保留最近100条）
 */
export function cleanupOldRecords(managementId: number): number {
  const db = getDatabase();

  const result = db.prepare(`
    DELETE FROM liq_grid_management_records
    WHERE management_id = ?
    AND id NOT IN (
      SELECT id FROM liq_grid_management_records
      WHERE management_id = ?
      ORDER BY executed_at DESC
      LIMIT 100
    )
  `).run(managementId, managementId);

  return result.changes;
}

/**
 * 转换数据库行到配置对象
 */
function rowToConfig(row: ManagementRow): LiqGridManagementConfig {
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    exchange: (row.exchange || 'binance') as ExchangeType,
    isActive: row.is_active === 1,
    intervalMinutes: row.interval_minutes,
    baseMargin: row.base_margin,
    marginPerLevel: row.margin_per_level,
    leverage: row.leverage,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
