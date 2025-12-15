// 支持的交易所
export type ExchangeType = 'binance' | 'okx' | 'bitget' | 'hyperliquid' | 'aster';

// 用户角色
export type UserRole = 'admin' | 'user';

// 用户信息
export interface User {
  id: number;
  username: string;
  role: UserRole;
  createdAt: string;
}

// API 配置
export interface ApiConfig {
  id: number;
  userId: number;
  exchange: ExchangeType;
  apiKey: string;
  apiSecretEncrypted: string;
  passphraseEncrypted?: string;
  isTestnet: boolean;
  permissions?: string[];
  createdAt: string;
  updatedAt: string;
}

// API 配置（前端显示用，隐藏敏感信息）
export interface ApiConfigDisplay {
  exchange: ExchangeType;
  apiKey: string;  // 部分隐藏: "abc***xyz"
  isTestnet: boolean;
  permissions?: string[];
}

// 登录请求
export interface AuthRequest {
  username: string;
  password: string;
  action: 'login' | 'register';
  inviteCode?: string;  // 注册时需要
}

// 邀请码
export interface InviteCode {
  id: number;
  code: string;
  createdBy: number;
  usedBy: number | null;
  usedByUsername: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

// 登录响应
export interface AuthResponse {
  success: boolean;
  token?: string;
  user?: User;
  error?: string;
}

// API 配置保存请求
export interface SaveApiConfigRequest {
  exchange: ExchangeType;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  isTestnet: boolean;
}

// 测试连接响应
export interface TestConnectionResponse {
  success: boolean;
  balance?: {
    asset: string;
    free: string;
    locked: string;
  }[];
  error?: string;
}

// JWT Payload
export interface JWTPayload {
  userId: number;
  username: string;
  iat: number;
  exp: number;
}
