import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { userQueries } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth';

// POST /api/user/password - 修改密码
export async function POST(request: NextRequest) {
  try {
    // 验证 token
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { success: false, error: '未授权' },
        { status: 401 }
      );
    }

    const token = authHeader.substring(7);
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json(
        { success: false, error: 'Token 无效' },
        { status: 401 }
      );
    }

    const { oldPassword, newPassword } = await request.json();

    // 验证输入
    if (!oldPassword || !newPassword) {
      return NextResponse.json(
        { success: false, error: '请输入原密码和新密码' },
        { status: 400 }
      );
    }

    if (newPassword.length < 6) {
      return NextResponse.json(
        { success: false, error: '新密码长度至少 6 个字符' },
        { status: 400 }
      );
    }

    // 获取用户信息
    const user = userQueries.findByUsername(payload.username);
    if (!user) {
      return NextResponse.json(
        { success: false, error: '用户不存在' },
        { status: 404 }
      );
    }

    // 验证原密码
    const isValid = await verifyPassword(oldPassword, user.password_hash);
    if (!isValid) {
      return NextResponse.json(
        { success: false, error: '原密码错误' },
        { status: 400 }
      );
    }

    // 更新密码
    const newPasswordHash = await hashPassword(newPassword);
    userQueries.updatePassword(user.id, newPasswordHash);

    return NextResponse.json({ success: true, message: '密码修改成功' });
  } catch (error) {
    console.error('Password change error:', error);
    return NextResponse.json(
      { success: false, error: '服务器错误' },
      { status: 500 }
    );
  }
}
