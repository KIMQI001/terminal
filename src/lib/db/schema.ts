// 数据库表结构 SQL

export const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  invite_code_used TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;

export const CREATE_INVITE_CODES_TABLE = `
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  created_by INTEGER NOT NULL,
  used_by INTEGER,
  used_at DATETIME,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (used_by) REFERENCES users(id)
)`;

export const CREATE_API_CONFIGS_TABLE = `
CREATE TABLE IF NOT EXISTS api_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  exchange TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_secret_encrypted TEXT NOT NULL,
  passphrase_encrypted TEXT,
  is_testnet INTEGER DEFAULT 0,
  permissions TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, exchange)
)`;

export const CREATE_NOTIFICATION_CONFIGS_TABLE = `
CREATE TABLE IF NOT EXISTS notification_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  dingtalk_webhook TEXT,
  dingtalk_secret_encrypted TEXT,
  enabled INTEGER DEFAULT 1,
  position_monitor_enabled INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`;

// 回放模拟盘存档
export const CREATE_REPLAY_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS replay_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  bar_count INTEGER NOT NULL,
  bars_replayed INTEGER NOT NULL,
  initial_capital REAL NOT NULL,
  quantity REAL NOT NULL,
  leverage REAL NOT NULL,
  final_equity REAL NOT NULL,
  realized_pnl REAL NOT NULL,
  unrealized_pnl REAL NOT NULL,
  net_pnl REAL NOT NULL,
  return_pct REAL NOT NULL,
  max_drawdown_pct REAL NOT NULL,
  total_trades INTEGER NOT NULL DEFAULT 0,
  win_count INTEGER NOT NULL DEFAULT 0,
  loss_count INTEGER NOT NULL DEFAULT 0,
  win_rate REAL NOT NULL DEFAULT 0,
  profit_factor REAL,
  expectancy_r REAL,
  score_total REAL NOT NULL DEFAULT 0,
  score_profit REAL NOT NULL DEFAULT 0,
  score_entry REAL NOT NULL DEFAULT 0,
  score_discipline REAL NOT NULL DEFAULT 0,
  grade TEXT,
  score_details TEXT,
  equity_curve TEXT,
  config_json TEXT,
  started_at INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`;

export const CREATE_REPLAY_TRADES_TABLE = `
CREATE TABLE IF NOT EXISTS replay_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_time INTEGER NOT NULL DEFAULT 0,
  entry_bar INTEGER NOT NULL DEFAULT 0,
  exit_price REAL,
  exit_time INTEGER,
  exit_bar INTEGER,
  exit_reason TEXT,
  stop_loss REAL,
  take_profit REAL,
  margin REAL NOT NULL DEFAULT 0,
  risk_amount REAL NOT NULL DEFAULT 0,
  pnl REAL NOT NULL DEFAULT 0,
  pnl_pct REAL NOT NULL DEFAULT 0,
  r_multiple REAL NOT NULL DEFAULT 0,
  mae REAL NOT NULL DEFAULT 0,
  mfe REAL NOT NULL DEFAULT 0,
  entry_score REAL,
  entry_deductions TEXT,
  discipline_flags TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES replay_sessions(id) ON DELETE CASCADE
)`;

// 索引
export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_api_configs_user_id ON api_configs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_api_configs_exchange ON api_configs(exchange)`,
  `CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code)`,
  `CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes(created_by)`,
  `CREATE INDEX IF NOT EXISTS idx_replay_sessions_user_id ON replay_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_replay_sessions_user_symbol ON replay_sessions(user_id, symbol)`,
  `CREATE INDEX IF NOT EXISTS idx_replay_sessions_user_created ON replay_sessions(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_replay_trades_session ON replay_trades(session_id)`,
];
