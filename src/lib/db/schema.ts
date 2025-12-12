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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`;

// 索引
export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_api_configs_user_id ON api_configs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_api_configs_exchange ON api_configs(exchange)`,
  `CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code)`,
  `CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes(created_by)`,
];
