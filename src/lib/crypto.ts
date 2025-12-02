import crypto from 'crypto';

// 加密配置
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;

// 从环境变量获取加密主密钥
function getMasterKey(): string {
  const envKey = process.env.API_ENCRYPTION_KEY;
  if (envKey) {
    return envKey;
  }
  // 开发环境使用固定密钥（警告：生产环境必须设置环境变量）
  console.warn('API_ENCRYPTION_KEY not set, using default key. Set API_ENCRYPTION_KEY in production!');
  return 'default-dev-key-change-in-production-12345';
}

// 派生加密密钥
function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(masterKey, salt, 100000, KEY_LENGTH, 'sha256');
}

// 加密数据
export function encrypt(plaintext: string): string {
  const masterKey = getMasterKey();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(masterKey, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // 格式: salt (32) + iv (16) + authTag (16) + encrypted
  const result = Buffer.concat([salt, iv, authTag, encrypted]);
  return result.toString('base64');
}

// 解密数据
export function decrypt(ciphertext: string): string {
  const masterKey = getMasterKey();
  const data = Buffer.from(ciphertext, 'base64');

  // 解析各部分
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

// 隐藏 API Key 中间部分
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return '***';
  }
  const prefix = apiKey.substring(0, 4);
  const suffix = apiKey.substring(apiKey.length - 4);
  return `${prefix}***${suffix}`;
}
