import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, extractTokenFromHeader } from '@/lib/auth';

const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || 'http://127.0.0.1:3002';

// 验证用户身份
async function authenticateUser(request: NextRequest): Promise<{ userId: number; username: string } | null> {
  const authHeader = request.headers.get('Authorization');
  const token = extractTokenFromHeader(authHeader);

  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  return { userId: payload.userId, username: payload.username };
}

/**
 * POST /api/analysis/liq-grid-management/start
 * 启动流动性网格托管
 */
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const body = await request.json();

    const response = await fetch(`${ANALYSIS_SERVICE_URL}/api/liq-grid-management/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.userId,
        ...body,
      }),
    });

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[LiqGridManagement Proxy] POST /start error:', error);
    return NextResponse.json({
      success: false,
      error: '代理请求失败',
    }, { status: 500 });
  }
}
