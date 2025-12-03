/**
 * SQLite 数据库初始化模块
 * 用于存储和管理交易信号记录
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// 确保数据目录存在
const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'signals.db');
let db: Database.Database | null = null;

/**
 * 初始化数据库
 */
export function initDatabase(): Database.Database {
  if (db) return db;

  console.log(`[DB] 初始化数据库: ${DB_PATH}`);
  db = new Database(DB_PATH);

  // 启用 WAL 模式以提高并发性能
  db.pragma('journal_mode = WAL');

  // 创建信号表
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('long', 'short')),
      confidence TEXT NOT NULL CHECK(confidence IN ('high', 'medium', 'low')),
      entry_price REAL NOT NULL,
      stop_loss REAL NOT NULL,
      take_profits TEXT NOT NULL,
      risk_reward REAL NOT NULL,
      reasoning TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'entered', 'stopped', 'profit', 'expired')),
      entered_at TEXT,
      exited_at TEXT,
      exit_price REAL,
      exit_reason TEXT,
      actual_rr REAL,
      pnl_percent REAL
    );

    CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_timeframe ON signals(timeframe);
    CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
    CREATE INDEX IF NOT EXISTS idx_signals_direction ON signals(direction);
  `);

  console.log('[DB] 数据库初始化完成');
  return db;
}

/**
 * 获取数据库实例
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('数据库未初始化，请先调用 initDatabase()');
  }
  return db;
}

/**
 * 关闭数据库连接
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[DB] 数据库连接已关闭');
  }
}

/**
 * 信号记录类型（数据库行格式）
 */
export interface SignalRow {
  id: string;
  created_at: string;
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  confidence: 'high' | 'medium' | 'low';
  entry_price: number;
  stop_loss: number;
  take_profits: string; // JSON 字符串
  risk_reward: number;
  reasoning: string | null;
  status: 'pending' | 'entered' | 'stopped' | 'profit' | 'expired';
  entered_at: string | null;
  exited_at: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  actual_rr: number | null;
  pnl_percent: number | null;
}

/**
 * 信号记录类型（应用层格式）
 */
export interface SignalRecord {
  id: string;
  createdAt: Date;
  symbol: string;
  timeframe: string;
  direction: 'long' | 'short';
  confidence: 'high' | 'medium' | 'low';
  entryPrice: number;
  stopLoss: number;
  takeProfits: number[];
  riskReward: number;
  reasoning: string | null;
  status: 'pending' | 'entered' | 'stopped' | 'profit' | 'expired';
  enteredAt: Date | null;
  exitedAt: Date | null;
  exitPrice: number | null;
  exitReason: string | null;
  actualRR: number | null;
  pnlPercent: number | null;
}

/**
 * 将数据库行转换为应用层记录
 */
export function rowToRecord(row: SignalRow): SignalRecord {
  return {
    id: row.id,
    createdAt: new Date(row.created_at),
    symbol: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,
    confidence: row.confidence,
    entryPrice: row.entry_price,
    stopLoss: row.stop_loss,
    takeProfits: JSON.parse(row.take_profits),
    riskReward: row.risk_reward,
    reasoning: row.reasoning,
    status: row.status,
    enteredAt: row.entered_at ? new Date(row.entered_at) : null,
    exitedAt: row.exited_at ? new Date(row.exited_at) : null,
    exitPrice: row.exit_price,
    exitReason: row.exit_reason,
    actualRR: row.actual_rr,
    pnlPercent: row.pnl_percent,
  };
}
