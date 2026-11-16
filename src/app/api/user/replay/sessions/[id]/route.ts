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

// GET /api/user/replay/sessions/:id - 单场详情
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const id = parseInt(params.id, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: '无效的 id' }, { status: 400 });
    }

    const found = replayQueries.findById(user.userId, id);
    if (!found) {
      return NextResponse.json({ error: '记录不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, session: found.session, trades: found.trades });
  } catch (error) {
    console.error('Get replay session error:', error);
    return NextResponse.json({ error: '获取回放记录失败' }, { status: 500 });
  }
}

// DELETE /api/user/replay/sessions/:id - 删除一场
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const id = parseInt(params.id, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: '无效的 id' }, { status: 400 });
    }

    const changes = replayQueries.deleteById(user.userId, id);
    if (changes === 0) {
      return NextResponse.json({ error: '记录不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete replay session error:', error);
    return NextResponse.json({ error: '删除回放记录失败' }, { status: 500 });
  }
}
