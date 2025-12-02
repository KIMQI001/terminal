import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcrypt';
import { JWTPayload } from '@/types/user';

// JWT 密钥（生产环境应使用环境变量）
function getJWTSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET || 'default-jwt-secret-change-in-production';
  return new TextEncoder().encode(secret);
}

// Token 过期时间（7天）
const TOKEN_EXPIRY = '7d';

// 生成 JWT Token
export async function generateToken(userId: number, username: string): Promise<string> {
  const secret = getJWTSecret();

  const token = await new SignJWT({ userId, username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(secret);

  return token;
}

// 验证 JWT Token
export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const secret = getJWTSecret();
    const { payload } = await jwtVerify(token, secret);

    return {
      userId: payload.userId as number,
      username: payload.username as string,
      iat: payload.iat as number,
      exp: payload.exp as number,
    };
  } catch {
    return null;
  }
}

// 哈希密码
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
}

// 验证密码
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// 从请求头中提取 Token
export function extractTokenFromHeader(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}
