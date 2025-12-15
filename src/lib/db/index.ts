import Database from 'better-sqlite3';
import path from 'path';
import { CREATE_USERS_TABLE, CREATE_INVITE_CODES_TABLE, CREATE_API_CONFIGS_TABLE, CREATE_NOTIFICATION_CONFIGS_TABLE, CREATE_INDEXES } from './schema';

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

  for (const indexSql of CREATE_INDEXES) {
    database.exec(indexSql);
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
      created_at: string;
      updated_at: string;
    } | undefined;
  },

  // 创建或更新通知配置（UPSERT）
  upsert: (
    userId: number,
    dingtalkWebhook: string | null,
    dingtalkSecretEncrypted: string | null,
    enabled: boolean
  ) => {
    const database = getDatabase();
    const stmt = database.prepare(`
      INSERT INTO notification_configs (user_id, dingtalk_webhook, dingtalk_secret_encrypted, enabled, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        dingtalk_webhook = excluded.dingtalk_webhook,
        dingtalk_secret_encrypted = excluded.dingtalk_secret_encrypted,
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(userId, dingtalkWebhook, dingtalkSecretEncrypted, enabled ? 1 : 0);
  },

  // 删除通知配置
  delete: (userId: number) => {
    const database = getDatabase();
    return database.prepare('DELETE FROM notification_configs WHERE user_id = ?').run(userId);
  },
};
