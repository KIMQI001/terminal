/**
 * 守塔托管状态存储
 * 持久化托管配置和状态到数据库
 */

import { getDatabase } from '../db';

// 交易所类型
export type ExchangeType = 'binance' | 'aster';

// 托管配置
export interface TowerManagementConfig {
  id: number;
  userId: number;
  symbol: string;                // 交易对 (BTCUSDC)
  exchange: ExchangeType;        // 交易所 (binance/aster)
  isActive: boolean;             // 是否启用
  intervalMinutes: number;       // 托管间隔（分钟）
  baseMargin: number;            // 基础保证金（USD 固定金额，marginPercent=0 时用）
  marginPercent: number;          // 账户百分比保证金（0/10/25/33），>0 时按 balance 算
  marginIncrement: number;       // 保证金递增
  towerLayers: number;           // 塔层数
  bullishStartLayer: number;     // 多塔起始层
  bearishStartLayer: number;     // 空塔起始层
  minSpacingRatio: number;       // 最小间距（万分比）
  minEntryDistance: number;      // 启动间距（点数）
  maxEntryDistancePercent: number; // 最大入场距离（百分比），默认 2%（超过当前价 2% 的 block 不下）
  trailingActivationRatio: number; // 追踪止盈激活比例（默认 0.02 = 2%）
  trailingCallbackRate: number;    // 追踪止盈回撤率（默认 0.3 = 0.3%）
  bullishLowFilter: number;       // 多单过滤：1=只下L以下的多单，0=不限制
  bearishHighFilter: number;      // 空单过滤：1=只下H以上的空单，0=不限制
  useHLPDFilter: boolean;         // 是否启用HLPD区域过滤（多单<=D, 空单>=P），默认 true
  biasFilter: number;              // MTF bias 过滤：1=只下同向单，0=不限
  lhHlOrders: number;              // LH/HL 不破单：1=在最新 HH 附近的 LH 下 SELL、在最新 LL 附近的 HL 下 BUY，0=不开启
  monitorTimeframe: string;       // 周期过滤：0=所有周期, 15m/1h/4h/1d 只下指定周期
  lastRunAt: string | null;      // 上次执行时间
  nextRunAt: string | null;      // 下次执行时间
  lastBias: 'long' | 'short' | 'wait'; // 上次确认的 MTF bias（用于检测翻转）
  createdAt: string;
  updatedAt: string;
}

// 托管执行记录
export interface TowerManagementRecord {
  id: number;
  managementId: number;
  executedAt: string;
  bullishCount: number;
  bearishCount: number;
  totalMargin: number;
  success: boolean;
  skipped: boolean;              // 是否跳过（订单充足）
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
  margin_percent: number;
  margin_increment: number;
  tower_layers: number;
  bullish_start_layer: number;
  bearish_start_layer: number;
  min_spacing_ratio: number;
  min_entry_distance: number;
  max_entry_distance_percent: number;
  trailing_activation_ratio: number;
  trailing_callback_rate: number;
  bullish_low_filter: number;
  bearish_high_filter: number;
  use_hlpd_filter: number;
  bias_filter: number;
  lh_hl_orders: number;
  monitor_timeframe: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_bias: string | null;
  created_at: string;
  updated_at: string;
}

interface RecordRow {
  id: number;
  management_id: number;
  executed_at: string;
  bullish_count: number;
  bearish_count: number;
  total_margin: number;
  success: number;
  skipped: number;
  error_message: string | null;
}

/**
 * 初始化托管相关表
 */
export function initTowerManagementTables(): void {
  const db = getDatabase();

  db.exec(`
    -- 托管配置表
    CREATE TABLE IF NOT EXISTS tower_management (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 5,
      base_margin REAL NOT NULL DEFAULT 100,
      margin_increment REAL NOT NULL DEFAULT 0,
      tower_layers INTEGER NOT NULL DEFAULT 3,
      bullish_start_layer INTEGER NOT NULL DEFAULT 1,
      bearish_start_layer INTEGER NOT NULL DEFAULT 1,
      min_spacing_ratio INTEGER NOT NULL DEFAULT 5,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, symbol)
    );

    -- 托管执行记录表
    CREATE TABLE IF NOT EXISTS tower_management_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      management_id INTEGER NOT NULL,
      executed_at TEXT NOT NULL,
      bullish_count INTEGER NOT NULL DEFAULT 0,
      bearish_count INTEGER NOT NULL DEFAULT 0,
      total_margin REAL NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      skipped INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      FOREIGN KEY (management_id) REFERENCES tower_management(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tower_management_active ON tower_management(is_active);
    CREATE INDEX IF NOT EXISTS idx_tower_management_user ON tower_management(user_id);
    CREATE INDEX IF NOT EXISTS idx_tower_records_management ON tower_management_records(management_id);
  `);

  // 迁移：添加 min_entry_distance 字段
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN min_entry_distance INTEGER NOT NULL DEFAULT 500`);
    console.log('[TowerManagement] 添加 min_entry_distance 字段');
  } catch { /* 列已存在 */ }

  // 迁移：添加 exchange 字段
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN exchange TEXT NOT NULL DEFAULT 'binance'`);
    console.log('[TowerManagement] 添加 exchange 字段');
  } catch { /* 列已存在 */ }

  // 迁移：添加追踪止盈配置字段
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN trailing_activation_ratio REAL NOT NULL DEFAULT 0.02`);
    console.log('[TowerManagement] 添加 trailing_activation_ratio 字段');
  } catch { /* 列已存在 */ }

  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN trailing_callback_rate REAL NOT NULL DEFAULT 0.3`);
    console.log('[TowerManagement] 添加 trailing_callback_rate 字段');
  } catch { /* 列已存在 */ }

  // 迁移：添加多空过滤字段
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN bullish_low_filter INTEGER NOT NULL DEFAULT 0`);
    console.log('[TowerManagement] 添加 bullish_low_filter 字段');
  } catch { /* 列已存在 */ }

  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN bearish_high_filter INTEGER NOT NULL DEFAULT 0`);
    console.log('[TowerManagement] 添加 bearish_high_filter 字段');
  } catch { /* 列已存在 */ }

  // 迁移：添加周期过滤字段
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN monitor_timeframe TEXT NOT NULL DEFAULT '0'`);
    console.log('[TowerManagement] 添加 monitor_timeframe 字段');
  } catch { /* 列已存在 */ }

  // 迁移：把 '0'（所有周期）的旧配置改成 '15m'（你手动看的 TF）
  // 一次性升级，避免历史数据继续走"5 TF 一起筛"的旧逻辑
  try {
    const result = db.prepare(`
      UPDATE tower_management
      SET monitor_timeframe = '15m'
      WHERE monitor_timeframe = '0' OR monitor_timeframe IS NULL OR monitor_timeframe = ''
    `).run();
    if (result.changes > 0) {
      console.log(`[TowerManagement] 已将 ${result.changes} 条旧 monitor_timeframe='0' 的配置升级为 '15m'`);
    }
  } catch (e) {
    console.error('[TowerManagement] monitor_timeframe 升级失败:', e);
  }

  // 迁移：添加 HLPD 区域过滤开关字段
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN use_hlpd_filter INTEGER NOT NULL DEFAULT 1`);
    console.log('[TowerManagement] 添加 use_hlpd_filter 字段');
  } catch { /* 列已存在 */ }

  // 迁移：添加 MTF bias 过滤开关字段
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN bias_filter INTEGER NOT NULL DEFAULT 0`);
    console.log('[TowerManagement] 添加 bias_filter 字段');
  } catch { /* 列已存在 */ }

  // 迁移：添加 margin_percent 字段
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN margin_percent INTEGER NOT NULL DEFAULT 0`);
    console.log('[TowerManagement] 添加 margin_percent 字段');
  } catch { /* 列已存在 */ }

  // 迁移：添加 last_bias 字段（记录上次确认的 MTF bias，用于检测翻转）
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN last_bias TEXT NOT NULL DEFAULT 'wait'`);
    console.log('[TowerManagement] 添加 last_bias 字段');
  } catch { /* 列已存在 */ }

  // 迁移：添加 lh_hl_orders 字段（不破单开关）
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN lh_hl_orders INTEGER NOT NULL DEFAULT 0`);
    console.log('[TowerManagement] 添加 lh_hl_orders 字段');
  } catch { /* 列已存在 */ }

  // 迁移：添加 max_entry_distance_percent 字段（最大入场距离百分比，默认 2%）
  try {
    db.exec(`ALTER TABLE tower_management ADD COLUMN max_entry_distance_percent INTEGER NOT NULL DEFAULT 20`);  // 整数 20 = 2.0%
    console.log('[TowerManagement] 添加 max_entry_distance_percent 字段');
  } catch { /* 列已存在 */ }

  console.log('[TowerManagement] 表初始化完成');
}

/**
 * 获取用户的托管配置
 */
export function getManagement(userId: number, symbol: string): TowerManagementConfig | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT * FROM tower_management WHERE user_id = ? AND symbol = ?
  `).get(userId, symbol) as ManagementRow | undefined;

  if (!row) return null;
  return rowToConfig(row);
}

/**
 * 获取所有活跃的托管配置
 */
export function getActiveManagements(): TowerManagementConfig[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT * FROM tower_management WHERE is_active = 1
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
  marginIncrement: number;
  towerLayers: number;
  bullishStartLayer: number;
  bearishStartLayer: number;
  minSpacingRatio: number;
  minEntryDistance: number;
  trailingActivationRatio?: number;
  trailingCallbackRate?: number;
  bullishLowFilter?: number;
  bearishHighFilter?: number;
  useHLPDFilter?: boolean;
  biasFilter?: number;
  lhHlOrders?: number;
  maxEntryDistancePercent?: number;
  marginPercent?: number;
  monitorTimeframe?: string;
}): TowerManagementConfig {
  const exchange = config.exchange || 'binance';
  const trailingActivationRatio = config.trailingActivationRatio ?? 0.02;
  const trailingCallbackRate = config.trailingCallbackRate ?? 0.3;
  const monitorTimeframe = config.monitorTimeframe ?? '15m';  // 默认 15m（你手动看的 TF）
  const useHLPDFilter = config.useHLPDFilter ?? true;
  const db = getDatabase();
  const now = new Date().toISOString();

  // 如果激活，立即执行第一次（设置 nextRunAt 为当前时间）
  const nextRunAt = config.isActive ? now : null;

  const existing = getManagement(config.userId, config.symbol);

  if (existing) {
    // 更新
    db.prepare(`
      UPDATE tower_management SET
        exchange = ?,
        is_active = ?,
        interval_minutes = ?,
        base_margin = ?,
        margin_percent = ?,
        margin_increment = ?,
        tower_layers = ?,
        bullish_start_layer = ?,
        bearish_start_layer = ?,
        min_spacing_ratio = ?,
        min_entry_distance = ?,
        trailing_activation_ratio = ?,
        trailing_callback_rate = ?,
        bullish_low_filter = ?,
        bearish_high_filter = ?,
        use_hlpd_filter = ?,
        bias_filter = ?,
        lh_hl_orders = ?,
        max_entry_distance_percent = ?,
        monitor_timeframe = ?,
        next_run_at = ?,
        updated_at = ?
      WHERE user_id = ? AND symbol = ?
    `).run(
      exchange,
      config.isActive ? 1 : 0,
      config.intervalMinutes,
      config.baseMargin,
      config.marginPercent ?? 0,
      config.marginIncrement,
      config.towerLayers,
      config.bullishStartLayer,
      config.bearishStartLayer,
      config.minSpacingRatio,
      config.minEntryDistance,
      trailingActivationRatio,
      trailingCallbackRate,
      config.bullishLowFilter ?? 0,
      config.bearishHighFilter ?? 0,
      useHLPDFilter ? 1 : 0,
      config.biasFilter ?? 0,
      config.lhHlOrders ?? 0,
      config.maxEntryDistancePercent ?? 20,
      monitorTimeframe,
      nextRunAt,
      now,
      config.userId,
      config.symbol
    );

    console.log(`[TowerManagement] 更新托管配置: userId=${config.userId}, symbol=${config.symbol}, exchange=${exchange}, active=${config.isActive}, monitorTimeframe=${monitorTimeframe}, useHLPDFilter=${useHLPDFilter}`);
  } else {
    // 创建
    db.prepare(`
      INSERT INTO tower_management (
        user_id, symbol, exchange, is_active, interval_minutes, base_margin, margin_percent, margin_increment,
        tower_layers, bullish_start_layer, bearish_start_layer, min_spacing_ratio, min_entry_distance,
        trailing_activation_ratio, trailing_callback_rate, bullish_low_filter, bearish_high_filter,
        use_hlpd_filter, bias_filter, lh_hl_orders, max_entry_distance_percent,
        monitor_timeframe, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.userId,
      config.symbol,
      exchange,
      config.isActive ? 1 : 0,
      config.intervalMinutes,
      config.baseMargin,
      config.marginPercent ?? 0,
      config.marginIncrement,
      config.towerLayers,
      config.bullishStartLayer,
      config.bearishStartLayer,
      config.minSpacingRatio,
      config.minEntryDistance,
      trailingActivationRatio,
      trailingCallbackRate,
      config.bullishLowFilter ?? 0,
      config.bearishHighFilter ?? 0,
      useHLPDFilter ? 1 : 0,
      config.biasFilter ?? 0,
      config.lhHlOrders ?? 0,
      config.maxEntryDistancePercent ?? 20,
      monitorTimeframe,
      nextRunAt,
      now,
      now
    );

    console.log(`[TowerManagement] 创建托管配置: userId=${config.userId}, symbol=${config.symbol}, exchange=${exchange}, monitorTimeframe=${monitorTimeframe}, useHLPDFilter=${useHLPDFilter}, biasFilter=${config.biasFilter ?? 0}`);
  }

  return getManagement(config.userId, config.symbol)!;
}

/**
 * 启动托管
 */
export function startManagement(userId: number, symbol: string, intervalMinutes: number): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();
  // 启动后立即执行第一次，设置 nextRunAt 为当前时间
  const nextRunAt = now;

  const result = db.prepare(`
    UPDATE tower_management SET
      is_active = 1,
      interval_minutes = ?,
      next_run_at = ?,
      updated_at = ?
    WHERE user_id = ? AND symbol = ?
  `).run(intervalMinutes, nextRunAt, now, userId, symbol);

  if (result.changes > 0) {
    console.log(`[TowerManagement] 启动托管: userId=${userId}, symbol=${symbol}, interval=${intervalMinutes}分钟, 立即执行`);
    return true;
  }
  return false;
}

/**
 * 停止托管
 */
export function stopManagement(userId: number, symbol: string): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE tower_management SET
      is_active = 0,
      next_run_at = NULL,
      updated_at = ?
    WHERE user_id = ? AND symbol = ?
  `).run(now, userId, symbol);

  if (result.changes > 0) {
    console.log(`[TowerManagement] 停止托管: userId=${userId}, symbol=${symbol}`);
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
    SELECT interval_minutes FROM tower_management WHERE id = ?
  `).get(managementId) as { interval_minutes: number } | undefined;

  if (!config) return;

  const nextRunAt = new Date(Date.now() + config.interval_minutes * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE tower_management SET
      last_run_at = ?,
      next_run_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(now, nextRunAt, now, managementId);
}

/**
 * 更新上次确认的 MTF bias
 * - 'wait' 不写入（保留 last real bias，避免误判翻转）
 * - 'long' / 'short' 覆盖写入
 */
export function updateLastBias(managementId: number, bias: 'long' | 'short' | 'wait'): void {
  if (bias === 'wait') return;
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tower_management SET
      last_bias = ?,
      updated_at = ?
    WHERE id = ?
  `).run(bias, now, managementId);
}

/**
 * 添加执行记录
 */
export function addRecord(record: {
  managementId: number;
  bullishCount: number;
  bearishCount: number;
  totalMargin: number;
  success: boolean;
  skipped: boolean;
  errorMessage?: string;
}): number {
  const db = getDatabase();
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO tower_management_records (
      management_id, executed_at, bullish_count, bearish_count, total_margin,
      success, skipped, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.managementId,
    now,
    record.bullishCount,
    record.bearishCount,
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
export function getRecentRecords(managementId: number, limit = 20): TowerManagementRecord[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT * FROM tower_management_records
    WHERE management_id = ?
    ORDER BY executed_at DESC
    LIMIT ?
  `).all(managementId, limit) as RecordRow[];

  return rows.map(row => ({
    id: row.id,
    managementId: row.management_id,
    executedAt: row.executed_at,
    bullishCount: row.bullish_count,
    bearishCount: row.bearish_count,
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
    FROM tower_management_records
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
    DELETE FROM tower_management_records
    WHERE management_id = ?
    AND id NOT IN (
      SELECT id FROM tower_management_records
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
function rowToConfig(row: ManagementRow): TowerManagementConfig {
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    exchange: (row.exchange || 'binance') as ExchangeType,
    isActive: row.is_active === 1,
    intervalMinutes: row.interval_minutes,
    baseMargin: row.base_margin,
    marginPercent: (row as any).margin_percent ?? 0,
    marginIncrement: row.margin_increment,
    towerLayers: row.tower_layers,
    bullishStartLayer: row.bullish_start_layer,
    bearishStartLayer: row.bearish_start_layer,
    minSpacingRatio: row.min_spacing_ratio,
    minEntryDistance: row.min_entry_distance ?? 500,
    maxEntryDistancePercent: (row as any).max_entry_distance_percent ?? 20,
    trailingActivationRatio: row.trailing_activation_ratio ?? 0.02,
    trailingCallbackRate: row.trailing_callback_rate ?? 0.3,
    bullishLowFilter: (row as any).bullish_low_filter ?? 0,
    bearishHighFilter: (row as any).bearish_high_filter ?? 0,
    useHLPDFilter: ((row as any).use_hlpd_filter ?? 1) === 1,
    biasFilter: (row as any).bias_filter ?? 0,
    lhHlOrders: (row as any).lh_hl_orders ?? 0,
    monitorTimeframe: (row as any).monitor_timeframe ?? '0',
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastBias: ((row as any).last_bias ?? 'wait') as 'long' | 'short' | 'wait',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
