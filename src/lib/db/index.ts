import Database from 'better-sqlite3';
import path from 'path';
import { CREATE_USERS_TABLE, CREATE_INVITE_CODES_TABLE, CREATE_API_CONFIGS_TABLE, CREATE_NOTIFICATION_CONFIGS_TABLE, CREATE_REPLAY_SESSIONS_TABLE, CREATE_REPLAY_TRADES_TABLE, CREATE_INDEXES } from './schema';

// 数据库文件路径（项目根目录下的 data 文件夹）
const DB_PATH = path.join(process.cwd(), 'data', 'terminal.db');

let db: Database.Database | null = null;

// 获取数据库实例
export function getDatabase(): Database.Database {
  if (db) return db;

  // 确保 data 目录存在
  const fs = require('fs');
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 创建数据库连接
  db = new Database(DB_PATH);

  // 启用外键约束
  db.pragma('foreign_keys = ON');

  // 初始化表结构
  initializeSchema(db);

  return db;
}

// 初始化数据库表结构
function initializeSchema(database: Database.Database) {
  database.exec(CREATE_USERS_TABLE);
  database.exec(CREATE_INVITE_CODES_TABLE);
  database.exec(CREATE_API_CONFIGS_TABLE);
  database.exec(CREATE_NOTIFICATION_CONFIGS_TABLE);
  database.exec(CREATE_REPLAY_SESSIONS_TABLE);
  database.exec(CREATE_REPLAY_TRADES_TABLE);

  for (const indexSql of CREATE_INDEXES) {
    database.exec(indexSql);
  }

  // 数据库迁移：为 notification_configs 添加 position_monitor_enabled 字段（如果不存在）
  try {
    database.exec(`
      ALTER TABLE notification_configs ADD COLUMN position_monitor_enabled INTEGER DEFAULT 0
    `);
    console.log('[DB Migration] Added position_monitor_enabled column to notification_configs');
  } catch (error) {
    // 字段可能已存在，忽略错误
  }

  // 检查是否存在 admin 账户，如果没有则创建
  const adminExists = database.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!adminExists) {
    // 创建默认 admin 账户 (密码: admin123)
    const bcrypt = require('bcrypt');
    const passwordHash = bcrypt.hashSync('admin123', 10);
    database.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', passwordHash, 'admin');
    console.log('Created default admin account (username: admin, password: admin123)');
  }
}

// 关闭数据库连接
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// 用户相关操作
export const userQueries = {
  // 通过用户名查找用户
  findByUsername: (username: string) => {
    const database = getDatabase();
    return database.prepare('SELECT * FROM users WHERE username = ?').get(username) as {
      id: number;
      username: string;
      password_hash: string;
      role: string;
      invite_code_used: string | null;
      created_at: string;
    } | undefined;
  },

  // 通过 ID 查找用户
  findById: (id: number) => {
    const database = getDatabase();
    return database.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id) as {
      id: number;
      username: string;
      role: string;
      created_at: string;
    } | undefined;
  },

  // 创建用户
  create: (username: string, passwordHash: string, inviteCode?: string) => {
    const database = getDatabase();
    const result = database.prepare('INSERT INTO users (username, password_hash, invite_code_used) VALUES (?, ?, ?)').run(username, passwordHash, inviteCode || null);
    return result.lastInsertRowid as number;
  },

  // 更新密码
  updatePassword: (userId: number, passwordHash: string) => {
    const database = getDatabase();
    return database.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  },
};

// 邀请码相关操作
export const inviteCodeQueries = {
  // 创建邀请码
  create: (code: string, createdBy: number, expiresAt?: string) => {
    const database = getDatabase();
    const result = database.prepare(
      'INSERT INTO invite_codes (code, created_by, expires_at) VALUES (?, ?, ?)'
    ).run(code, createdBy, expiresAt || null);
    return result.lastInsertRowid as number;
  },

  // 通过邀请码查找
  findByCode: (code: string) => {
    const database = getDatabase();
    return database.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as {
      id: number;
      code: string;
      created_by: number;
      used_by: number | null;
      used_at: string | null;
      expires_at: string | null;
      created_at: string;
    } | undefined;
  },

  // 验证邀请码是否有效
  isValid: (code: string) => {
    const database = getDatabase();
    const inviteCode = database.prepare(
      "SELECT * FROM invite_codes WHERE code = ? AND used_by IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))"
    ).get(code);
    return !!inviteCode;
  },

  // 使用邀请码
  use: (code: string, userId: number) => {
    const database = getDatabase();
    return database.prepare(
      "UPDATE invite_codes SET used_by = ?, used_at = datetime('now') WHERE code = ? AND used_by IS NULL"
    ).run(userId, code);
  },

  // 获取用户创建的所有邀请码
  findByCreator: (createdBy: number) => {
    const database = getDatabase();
    return database.prepare(
      'SELECT ic.*, u.username as used_by_username FROM invite_codes ic LEFT JOIN users u ON ic.used_by = u.id WHERE ic.created_by = ? ORDER BY ic.created_at DESC'
    ).all(createdBy) as {
      id: number;
      code: string;
      created_by: number;
      used_by: number | null;
      used_by_username: string | null;
      used_at: string | null;
      expires_at: string | null;
      created_at: string;
    }[];
  },

  // 删除邀请码
  delete: (id: number, createdBy: number) => {
    const database = getDatabase();
    return database.prepare('DELETE FROM invite_codes WHERE id = ? AND created_by = ?').run(id, createdBy);
  },
};

// API 配置相关操作
export const apiConfigQueries = {
  // 获取用户的所有 API 配置
  findByUserId: (userId: number) => {
    const database = getDatabase();
    return database.prepare('SELECT * FROM api_configs WHERE user_id = ?').all(userId) as {
      id: number;
      user_id: number;
      exchange: string;
      api_key: string;
      api_secret_encrypted: string;
      passphrase_encrypted: string | null;
      is_testnet: number;
      permissions: string | null;
      created_at: string;
      updated_at: string;
    }[];
  },

  // 获取用户特定交易所的配置
  findByUserAndExchange: (userId: number, exchange: string) => {
    const database = getDatabase();
    return database.prepare('SELECT * FROM api_configs WHERE user_id = ? AND exchange = ?').get(userId, exchange) as {
      id: number;
      user_id: number;
      exchange: string;
      api_key: string;
      api_secret_encrypted: string;
      passphrase_encrypted: string | null;
      is_testnet: number;
      permissions: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;
  },

  // 创建或更新 API 配置（UPSERT）
  upsert: (
    userId: number,
    exchange: string,
    apiKey: string,
    apiSecretEncrypted: string,
    passphraseEncrypted: string | null,
    isTestnet: boolean,
    permissions: string | null
  ) => {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO api_configs (user_id, exchange, api_key, api_secret_encrypted, passphrase_encrypted, is_testnet, permissions, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, exchange) DO UPDATE SET
        api_key = excluded.api_key,
        api_secret_encrypted = excluded.api_secret_encrypted,
        passphrase_encrypted = excluded.passphrase_encrypted,
        is_testnet = excluded.is_testnet,
        permissions = excluded.permissions,
        updated_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(userId, exchange, apiKey, apiSecretEncrypted, passphraseEncrypted, isTestnet ? 1 : 0, permissions);
  },

  // 删除 API 配置
  delete: (userId: number, exchange: string) => {
    const database = getDatabase();
    return database.prepare('DELETE FROM api_configs WHERE user_id = ? AND exchange = ?').run(userId, exchange);
  },
};

// 通知配置相关操作
export const notificationConfigQueries = {
  // 获取用户的通知配置
  findByUserId: (userId: number) => {
    const database = getDatabase();
    return database.prepare('SELECT * FROM notification_configs WHERE user_id = ?').get(userId) as {
      id: number;
      user_id: number;
      dingtalk_webhook: string | null;
      dingtalk_secret_encrypted: string | null;
      enabled: number;
      position_monitor_enabled: number;
      created_at: string;
      updated_at: string;
    } | undefined;
  },

  // 创建或更新通知配置（UPSERT）
  upsert: (
    userId: number,
    dingtalkWebhook: string | null,
    dingtalkSecretEncrypted: string | null,
    enabled: boolean,
    positionMonitorEnabled: boolean = false
  ) => {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO notification_configs (user_id, dingtalk_webhook, dingtalk_secret_encrypted, enabled, position_monitor_enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        dingtalk_webhook = excluded.dingtalk_webhook,
        dingtalk_secret_encrypted = excluded.dingtalk_secret_encrypted,
        enabled = excluded.enabled,
        position_monitor_enabled = excluded.position_monitor_enabled,
        updated_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(userId, dingtalkWebhook, dingtalkSecretEncrypted, enabled ? 1 : 0, positionMonitorEnabled ? 1 : 0);
  },

  // 删除通知配置
  delete: (userId: number) => {
    const database = getDatabase();
    return database.prepare('DELETE FROM notification_configs WHERE user_id = ?').run(userId);
  },
};

// ---------------------------------------------------------------------------
// 回放模拟盘存档
// ---------------------------------------------------------------------------

export interface ReplayTradeInput {
  seq: number;
  side: string;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  entryBar: number;
  exitPrice?: number | null;
  exitTime?: number | null;
  exitBar?: number | null;
  exitReason?: string | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  margin: number;
  riskAmount: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  mae: number;
  mfe: number;
  entryScore?: number | null;
  entryDeductions?: unknown;
  disciplineFlags?: unknown;
}

export interface ReplaySessionInput {
  symbol: string;
  timeframe: string;
  barCount: number;
  barsReplayed: number;
  initialCapital: number;
  quantity: number;
  leverage: number;
  finalEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  netPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  profitFactor: number | null;
  expectancyR: number | null;
  scoreTotal: number;
  scoreProfit: number;
  scoreEntry: number;
  scoreDiscipline: number;
  grade: string | null;
  scoreDetails: unknown;
  equityCurve: unknown;
  config: unknown;
  startedAt: number;
  endedAt: number;
}

/** 从 trades 服务端重算聚合指标（不信任客户端上报的统计） */
function recomputeAggregates(trades: ReplayTradeInput[]) {
  let wins = 0;
  let losses = 0;
  let netPnl = 0;
  let winSum = 0;
  let lossSum = 0;
  let rSum = 0;

  for (const t of trades) {
    netPnl += t.pnl;
    rSum += t.rMultiple;
    if (t.pnl > 0) {
      wins += 1;
      winSum += t.pnl;
    } else if (t.pnl < 0) {
      losses += 1;
      lossSum += t.pnl;
    }
  }

  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;
  const profitFactor = lossSum < 0 ? winSum / Math.abs(lossSum) : winSum > 0 ? null : 0;
  const expectancyR = trades.length > 0 ? rSum / trades.length : 0;

  return { wins, losses, netPnl, winRate, profitFactor, expectancyR };
}

export const replayQueries = {
  /** 保存一场回放（含逐笔明细） */
  insertSession: (userId: number, session: ReplaySessionInput, trades: ReplayTradeInput[]) => {
    const database = getDatabase();

    const insertSession = database.prepare(`
      INSERT INTO replay_sessions (
        user_id, symbol, timeframe, bar_count, bars_replayed,
        initial_capital, quantity, leverage,
        final_equity, realized_pnl, unrealized_pnl, net_pnl, return_pct, max_drawdown_pct,
        total_trades, win_count, loss_count, win_rate, profit_factor, expectancy_r,
        score_total, score_profit, score_entry, score_discipline, grade,
        score_details, equity_curve, config_json, started_at, ended_at
      ) VALUES (
        @user_id, @symbol, @timeframe, @bar_count, @bars_replayed,
        @initial_capital, @quantity, @leverage,
        @final_equity, @realized_pnl, @unrealized_pnl, @net_pnl, @return_pct, @max_drawdown_pct,
        @total_trades, @win_count, @loss_count, @win_rate, @profit_factor, @expectancy_r,
        @score_total, @score_profit, @score_entry, @score_discipline, @grade,
        @score_details, @equity_curve, @config_json, @started_at, @ended_at
      )
    `);

    const insertTrade = database.prepare(`
      INSERT INTO replay_trades (
        session_id, seq, side, quantity,
        entry_price, entry_time, entry_bar,
        exit_price, exit_time, exit_bar, exit_reason,
        stop_loss, take_profit, margin, risk_amount,
        pnl, pnl_pct, r_multiple, mae, mfe,
        entry_score, entry_deductions, discipline_flags
      ) VALUES (
        @session_id, @seq, @side, @quantity,
        @entry_price, @entry_time, @entry_bar,
        @exit_price, @exit_time, @exit_bar, @exit_reason,
        @stop_loss, @take_profit, @margin, @risk_amount,
        @pnl, @pnl_pct, @r_multiple, @mae, @mfe,
        @entry_score, @entry_deductions, @discipline_flags
      )
    `);

    const tx = database.transaction(() => {
      const agg = recomputeAggregates(trades);
      const initial = session.initialCapital || 1;
      const netPnl = agg.netPnl;
      const returnPct = (netPnl / initial) * 100;

      const result = insertSession.run({
        user_id: userId,
        symbol: session.symbol,
        timeframe: session.timeframe,
        bar_count: session.barCount,
        bars_replayed: session.barsReplayed,
        initial_capital: session.initialCapital,
        quantity: session.quantity,
        leverage: session.leverage,
        final_equity: session.finalEquity,
        realized_pnl: session.realizedPnl,
        unrealized_pnl: session.unrealizedPnl,
        net_pnl: netPnl,
        return_pct: returnPct,
        max_drawdown_pct: session.maxDrawdownPct,
        total_trades: trades.length,
        win_count: agg.wins,
        loss_count: agg.losses,
        win_rate: agg.winRate,
        profit_factor: agg.profitFactor,
        expectancy_r: agg.expectancyR,
        score_total: session.scoreTotal,
        score_profit: session.scoreProfit,
        score_entry: session.scoreEntry,
        score_discipline: session.scoreDiscipline,
        grade: session.grade,
        score_details: JSON.stringify(session.scoreDetails ?? null),
        equity_curve: JSON.stringify(session.equityCurve ?? []),
        config_json: JSON.stringify(session.config ?? null),
        started_at: session.startedAt,
        ended_at: session.endedAt,
      });

      const sessionId = result.lastInsertRowid as number;

      for (const t of trades) {
        insertTrade.run({
          session_id: sessionId,
          seq: t.seq,
          side: t.side,
          quantity: t.quantity,
          entry_price: t.entryPrice,
          entry_time: t.entryTime ?? 0,
          entry_bar: t.entryBar ?? 0,
          exit_price: t.exitPrice ?? null,
          exit_time: t.exitTime ?? null,
          exit_bar: t.exitBar ?? null,
          exit_reason: t.exitReason ?? null,
          stop_loss: t.stopLoss ?? null,
          take_profit: t.takeProfit ?? null,
          margin: t.margin ?? 0,
          risk_amount: t.riskAmount ?? 0,
          pnl: t.pnl ?? 0,
          pnl_pct: t.pnlPct ?? 0,
          r_multiple: t.rMultiple ?? 0,
          mae: t.mae ?? 0,
          mfe: t.mfe ?? 0,
          entry_score: t.entryScore ?? null,
          entry_deductions: t.entryDeductions ? JSON.stringify(t.entryDeductions) : null,
          discipline_flags: t.disciplineFlags ? JSON.stringify(t.disciplineFlags) : null,
        });
      }

      return sessionId;
    });

    return tx();
  },

  /** 列出用户的回放场次 */
  listByUser: (
    userId: number,
    options: { limit?: number; offset?: number; symbol?: string } = {}
  ) => {
    const database = getDatabase();
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);
    const symbol = options.symbol;

    if (symbol) {
      return database
        .prepare(
          `SELECT id, symbol, timeframe, bar_count, bars_replayed, initial_capital, quantity, leverage,
                  final_equity, realized_pnl, unrealized_pnl, net_pnl, return_pct, max_drawdown_pct,
                  total_trades, win_count, loss_count, win_rate, profit_factor, expectancy_r,
                  score_total, score_profit, score_entry, score_discipline, grade,
                  started_at, ended_at, created_at
           FROM replay_sessions
           WHERE user_id = ? AND symbol = ?
           ORDER BY id DESC LIMIT ? OFFSET ?`
        )
        .all(userId, symbol, limit, offset);
    }

    return database
      .prepare(
        `SELECT id, symbol, timeframe, bar_count, bars_replayed, initial_capital, quantity, leverage,
                final_equity, realized_pnl, unrealized_pnl, net_pnl, return_pct, max_drawdown_pct,
                total_trades, win_count, loss_count, win_rate, profit_factor, expectancy_r,
                score_total, score_profit, score_entry, score_discipline, grade,
                started_at, ended_at, created_at
         FROM replay_sessions
         WHERE user_id = ?
         ORDER BY id DESC LIMIT ? OFFSET ?`
      )
      .all(userId, limit, offset);
  },

  /** 单场详情（含逐笔明细） */
  findById: (userId: number, id: number) => {
    const database = getDatabase();
    const session = database
      .prepare('SELECT * FROM replay_sessions WHERE id = ? AND user_id = ?')
      .get(id, userId) as Record<string, unknown> | undefined;
    if (!session) return undefined;

    const trades = database
      .prepare('SELECT * FROM replay_trades WHERE session_id = ? ORDER BY seq ASC')
      .all(id);

    return { session, trades };
  },

  /** 累计战绩 */
  statsByUser: (userId: number, symbol?: string) => {
    const database = getDatabase();
    const where = symbol ? 'WHERE user_id = ? AND symbol = ?' : 'WHERE user_id = ?';
    const params: unknown[] = symbol ? [userId, symbol] : [userId];

    const overall = database
      .prepare(
        `SELECT COUNT(*) AS sessions,
                SUM(total_trades) AS totalTrades,
                SUM(win_count) AS wins,
                SUM(loss_count) AS losses,
                SUM(net_pnl) AS totalPnl,
                AVG(net_pnl) AS avgPnl,
                AVG(score_total) AS avgScore,
                MAX(score_total) AS bestScore,
                AVG(max_drawdown_pct) AS avgMaxDrawdownPct
         FROM replay_sessions ${where}`
      )
      .get(...params) as Record<string, number | null>;

    const bySymbol = database
      .prepare(
        `SELECT symbol,
                COUNT(*) AS sessions,
                SUM(net_pnl) AS totalPnl,
                AVG(score_total) AS avgScore,
                SUM(win_count) AS wins,
                SUM(loss_count) AS losses
         FROM replay_sessions ${where}
         GROUP BY symbol
         ORDER BY sessions DESC`
      )
      .all(...params) as {
      symbol: string;
      sessions: number;
      totalPnl: number;
      avgScore: number;
      wins: number;
      losses: number;
    }[];

    const wins = overall.wins ?? 0;
    const losses = overall.losses ?? 0;
    const decided = wins + losses;

    return {
      overall: {
        sessions: overall.sessions ?? 0,
        totalTrades: overall.totalTrades ?? 0,
        wins,
        losses,
        totalPnl: overall.totalPnl ?? 0,
        avgPnl: overall.avgPnl ?? 0,
        avgScore: overall.avgScore ?? 0,
        bestScore: overall.bestScore ?? 0,
        overallWinRate: decided > 0 ? (wins / decided) * 100 : 0,
        avgMaxDrawdownPct: overall.avgMaxDrawdownPct ?? 0,
      },
      bySymbol: bySymbol.map((s) => {
        const d = s.wins + s.losses;
        return {
          symbol: s.symbol,
          sessions: s.sessions,
          totalPnl: s.totalPnl ?? 0,
          avgScore: s.avgScore ?? 0,
          winRate: d > 0 ? (s.wins / d) * 100 : 0,
        };
      }),
    };
  },

  /** 删除一场 */
  deleteById: (userId: number, id: number) => {
    const database = getDatabase();
    const tx = database.transaction(() => {
      database.prepare('DELETE FROM replay_trades WHERE session_id = ?').run(id);
      const r = database.prepare('DELETE FROM replay_sessions WHERE id = ? AND user_id = ?').run(id, userId);
      return r.changes;
    });
    return tx();
  },
};
