/**
 * 读取用户 API 配置
 * 从 terminal.db 读取并解密 Binance API 配置
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

// 加密配置（与 src/lib/crypto.ts 一致）
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

// 获取加密主密钥
function getMasterKey(): string {
  const envKey = process.env.API_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
  if (envKey) {
    return envKey;
  }
  console.warn('[ApiConfigReader] API_ENCRYPTION_KEY 未设置，使用默认密钥');
  return 'default-dev-key-change-in-production-12345';
}

// 派生加密密钥
function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(masterKey, salt, 100000, KEY_LENGTH, 'sha256');
}

// 解密数据
function decrypt(ciphertext: string): string {
  const masterKey = getMasterKey();
  const data = Buffer.from(ciphertext, 'base64');

  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(masterKey, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

export interface BinanceApiConfig {
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
}

export interface AsterApiConfig {
  apiKey: string;
  apiSecret: string;
}

export interface DingtalkConfig {
  webhook: string;
  secret: string;
}

// 数据库行格式
interface ApiConfigRow {
  id: number;
  user_id: number;
  exchange: string;
  api_key: string;
  api_secret_encrypted: string;
  passphrase_encrypted: string | null;
  is_testnet: number;
  permissions: string | null;
}

let db: Database.Database | null = null;

/**
 * 获取 terminal.db 数据库连接
 */
function getTerminalDatabase(): Database.Database {
  if (db) return db;

  // 支持环境变量配置数据库路径
  let dbPath = process.env.TERMINAL_DB_PATH;

  if (!dbPath) {
    // 默认路径：从 analysis-service 目录向上到 terminal 根目录
    // 开发环境: analysis-service/src/order -> ../../data
    // 生产环境: analysis-service/dist/order -> ../../data
    dbPath = path.join(__dirname, '../../data/terminal.db');

    // 如果上面路径不存在，尝试从 analysis-service 向上一级
    if (!fs.existsSync(dbPath)) {
      dbPath = path.join(__dirname, '../../../data/terminal.db');
    }
  }

  if (!fs.existsSync(dbPath)) {
    throw new Error(`terminal.db 不存在: ${dbPath}`);
  }

  db = new Database(dbPath, { readonly: true });
  return db;
}

/**
 * 获取用户的 Binance API 配置
 */
export function getBinanceApiConfig(userId: number): BinanceApiConfig | null {
  try {
    const database = getTerminalDatabase();

    const row = database.prepare(`
      SELECT * FROM api_configs WHERE user_id = ? AND exchange = 'binance'
    `).get(userId) as ApiConfigRow | undefined;

    if (!row) {
      console.warn(`[ApiConfigReader] 用户 ${userId} 没有 Binance API 配置`);
      return null;
    }

    return {
      apiKey: row.api_key,
      apiSecret: decrypt(row.api_secret_encrypted),
      isTestnet: row.is_testnet === 1,
    };
  } catch (error) {
    console.error('[ApiConfigReader] 获取 API 配置失败:', error);
    return null;
  }
}

/**
 * 获取第一个有 Binance 配置的用户
 * 用于守塔订单监控（假设单用户场景）
 */
export function getFirstBinanceApiConfig(): { userId: number; config: BinanceApiConfig } | null {
  try {
    const database = getTerminalDatabase();

    const row = database.prepare(`
      SELECT * FROM api_configs WHERE exchange = 'binance' ORDER BY user_id LIMIT 1
    `).get() as ApiConfigRow | undefined;

    if (!row) {
      console.warn('[ApiConfigReader] 没有找到 Binance API 配置');
      return null;
    }

    return {
      userId: row.user_id,
      config: {
        apiKey: row.api_key,
        apiSecret: decrypt(row.api_secret_encrypted),
        isTestnet: row.is_testnet === 1,
      },
    };
  } catch (error) {
    console.error('[ApiConfigReader] 获取 API 配置失败:', error);
    return null;
  }
}

/**
 * 获取用户的 Aster DEX API 配置
 */
export function getAsterApiConfig(userId: number): AsterApiConfig | null {
  try {
    const database = getTerminalDatabase();

    const row = database.prepare(`
      SELECT * FROM api_configs WHERE user_id = ? AND exchange = 'aster'
    `).get(userId) as ApiConfigRow | undefined;

    if (!row) {
      console.warn(`[ApiConfigReader] 用户 ${userId} 没有 Aster API 配置`);
      return null;
    }

    return {
      apiKey: row.api_key,
      apiSecret: decrypt(row.api_secret_encrypted),
    };
  } catch (error) {
    console.error('[ApiConfigReader] 获取 Aster API 配置失败:', error);
    return null;
  }
}

/**
 * 获取第一个有 Aster 配置的用户
 */
export function getFirstAsterApiConfig(): { userId: number; config: AsterApiConfig } | null {
  try {
    const database = getTerminalDatabase();

    const row = database.prepare(`
      SELECT * FROM api_configs WHERE exchange = 'aster' ORDER BY user_id LIMIT 1
    `).get() as ApiConfigRow | undefined;

    if (!row) {
      console.warn('[ApiConfigReader] 没有找到 Aster API 配置');
      return null;
    }

    return {
      userId: row.user_id,
      config: {
        apiKey: row.api_key,
        apiSecret: decrypt(row.api_secret_encrypted),
      },
    };
  } catch (error) {
    console.error('[ApiConfigReader] 获取 Aster API 配置失败:', error);
    return null;
  }
}

// 通知配置数据库行格式
interface NotificationConfigRow {
  id: number;
  user_id: number;
  dingtalk_webhook: string | null;
  dingtalk_secret_encrypted: string | null;
  enabled: number;
  position_monitor_enabled: number;
}

/**
 * 获取用户的钉钉配置
 */
export function getUserDingtalkConfig(userId: number): DingtalkConfig | null {
  try {
    const database = getTerminalDatabase();

    const row = database.prepare(`
      SELECT * FROM notification_configs WHERE user_id = ? AND enabled = 1
    `).get(userId) as NotificationConfigRow | undefined;

    if (!row || !row.dingtalk_webhook || !row.dingtalk_secret_encrypted) {
      return null;
    }

    return {
      webhook: row.dingtalk_webhook,
      secret: decrypt(row.dingtalk_secret_encrypted),
    };
  } catch (error) {
    console.error('[ApiConfigReader] 获取钉钉配置失败:', error);
    return null;
  }
}

/**
 * 获取用户是否启用了仓位监控
 */
export function isPositionMonitorEnabled(userId: number): boolean {
  try {
    const database = getTerminalDatabase();

    // 首先检查列是否存在
    const tableInfo = database.prepare('PRAGMA table_info(notification_configs)').all() as { name: string }[];
    const hasColumn = tableInfo.some(col => col.name === 'position_monitor_enabled');

    if (!hasColumn) {
      console.log('[ApiConfigReader] notification_configs 表没有 position_monitor_enabled 列，仓位监控默认关闭');
      return false;
    }

    const row = database.prepare(`
      SELECT position_monitor_enabled FROM notification_configs WHERE user_id = ? AND enabled = 1
    `).get(userId) as { position_monitor_enabled: number } | undefined;

    return row?.position_monitor_enabled === 1;
  } catch (error) {
    console.error('[ApiConfigReader] 获取仓位监控配置失败:', error);
    return false;
  }
}

/**
 * 获取用户是否启用了订单成交通知
 */
export function isOrderNotifyEnabled(userId: number): boolean {
  try {
    const database = getTerminalDatabase();

    // 首先检查列是否存在
    const tableInfo = database.prepare('PRAGMA table_info(notification_configs)').all() as { name: string }[];
    const hasColumn = tableInfo.some(col => col.name === 'order_notify_enabled');

    if (!hasColumn) {
      console.log('[ApiConfigReader] notification_configs 表没有 order_notify_enabled 列，订单通知默认开启');
      return true;
    }

    const row = database.prepare(`
      SELECT order_notify_enabled FROM notification_configs WHERE user_id = ? AND enabled = 1
    `).get(userId) as { order_notify_enabled: number } | undefined;

    // 默认开启
    return row?.order_notify_enabled !== 0;
  } catch (error) {
    console.error('[ApiConfigReader] 获取订单通知配置失败:', error);
    return true;
  }
}

/**
 * 关闭数据库连接
 */
export function closeApiConfigReader(): void {
  if (db) {
    db.close();
    db = null;
  }
}
