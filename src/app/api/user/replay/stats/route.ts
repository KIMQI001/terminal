import { NextRequest, NextResponse } from 'next/server';
import { replayQueries } from '@/lib/db';
import { verifyToken, extractTokenFromHeader } from '@/lib/auth';

export const dynamic = 'force-dynamic';

async function authenticateUser(request: NextRequest): Promise<{ userId: number; username: string } | null> {
  const authHeader = request.headers.get('Authorization');
  const token = extractTokenFromHeader(authHeader);
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return null;
  return { userId: payload.userId, username: payload.username };
}

// GET /api/user/replay/stats - 累计战绩
export async function GET(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const symbol = request.nextUrl.searchParams.get('symbol') || undefined;
    const stats = replayQueries.statsByUser(user.userId, symbol);
    return NextResponse.json({ success: true, stats });
  } catch (error) {
    console.error('Get replay stats error:', error);
    return NextResponse.json({ error: '获取累计战绩失败' }, { status: 500 });
  }
}
