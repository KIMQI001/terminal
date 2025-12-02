import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { userQueries, inviteCodeQueries } from '@/lib/db';
import { nanoid } from 'nanoid';

// 验证是否为管理员
async function verifyAdmin(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  const payload = await verifyToken(token);
  if (!payload) {
    return null;
  }

  const user = userQueries.findById(payload.userId);
  if (!user || user.role !== 'admin') {
    return null;
  }

  return user;
}

// GET /api/admin/invite-codes - 获取邀请码列表
export async function GET(request: NextRequest) {
  try {
    const admin = await verifyAdmin(request);
    if (!admin) {
      return NextResponse.json(
        { success: false, error: '需要管理员权限' },
        { status: 403 }
      );
    }

    const codes = inviteCodeQueries.findByCreator(admin.id);

    return NextResponse.json({
      success: true,
      codes: codes.map((code) => ({
        id: code.id,
        code: code.code,
        usedBy: code.used_by_username,
        usedAt: code.used_at,
        expiresAt: code.expires_at,
        createdAt: code.created_at,
      })),
    });
  } catch (error) {
    console.error('Get invite codes error:', error);
    return NextResponse.json(
      { success: false, error: '服务器错误' },
      { status: 500 }
    );
  }
}

// POST /api/admin/invite-codes - 创建邀请码
export async function POST(request: NextRequest) {
  try {
    const admin = await verifyAdmin(request);
    if (!admin) {
      return NextResponse.json(
        { success: false, error: '需要管理员权限' },
        { status: 403 }
      );
    }

    const { expiresInDays } = await request.json().catch(() => ({}));

    // 生成随机邀请码
    const code = nanoid(8).toUpperCase();

    // 计算过期时间
    let expiresAt: string | undefined;
    if (expiresInDays && typeof expiresInDays === 'number' && expiresInDays > 0) {
      const date = new Date();
      date.setDate(date.getDate() + expiresInDays);
      expiresAt = date.toISOString();
    }

    const id = inviteCodeQueries.create(code, admin.id, expiresAt);

    return NextResponse.json({
      success: true,
      inviteCode: {
        id,
        code,
        expiresAt,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Create invite code error:', error);
    return NextResponse.json(
      { success: false, error: '服务器错误' },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/invite-codes?id=xxx - 删除邀请码
export async function DELETE(request: NextRequest) {
  try {
    const admin = await verifyAdmin(request);
    if (!admin) {
      return NextResponse.json(
        { success: false, error: '需要管理员权限' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const idStr = searchParams.get('id');

    if (!idStr) {
      return NextResponse.json(
        { success: false, error: '请提供邀请码 ID' },
        { status: 400 }
      );
    }

    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      return NextResponse.json(
        { success: false, error: '无效的邀请码 ID' },
        { status: 400 }
      );
    }

    const result = inviteCodeQueries.delete(id, admin.id);
    if (result.changes === 0) {
      return NextResponse.json(
        { success: false, error: '邀请码不存在或无权删除' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Delete invite code error:', error);
    return NextResponse.json(
      { success: false, error: '服务器错误' },
      { status: 500 }
    );
  }
}
