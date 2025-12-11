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
 * GET /api/analysis/liq-grid-management
 * 获取流动性网格托管配置
 */
export async function GET(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol');

  if (!symbol) {
    return NextResponse.json({ error: '缺少 symbol 参数' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `${ANALYSIS_SERVICE_URL}/api/liq-grid-management?userId=${user.userId}&symbol=${symbol}`
    );

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('[LiqGridManagement Proxy] GET error:', error);
    return NextResponse.json({
      success: false,
      error: '代理请求失败',
    }, { status: 500 });
  }
}

/**
 * POST /api/analysis/liq-grid-management
 * 更新流动性网格托管配置
 */
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const body = await request.json();

    const response = await fetch(`${ANALYSIS_SERVICE_URL}/api/liq-grid-management`, {
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
    console.error('[LiqGridManagement Proxy] POST error:', error);
    return NextResponse.json({
      success: false,
      error: '代理请求失败',
    }, { status: 500 });
  }
}
