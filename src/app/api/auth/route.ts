import { NextRequest, NextResponse } from 'next/server';
import { userQueries, inviteCodeQueries } from '@/lib/db';
import { generateToken, hashPassword, verifyPassword } from '@/lib/auth';
import { AuthRequest, AuthResponse, UserRole } from '@/types/user';

// POST /api/auth - 登录或注册
export async function POST(request: NextRequest) {
  try {
    const body: AuthRequest = await request.json();
    const { username, password, action } = body;

    // 验证输入
    if (!username || !password) {
      return NextResponse.json<AuthResponse>(
        { success: false, error: '用户名和密码不能为空' },
        { status: 400 }
      );
    }

    if (username.length < 3 || username.length > 20) {
      return NextResponse.json<AuthResponse>(
        { success: false, error: '用户名长度应为 3-20 个字符' },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json<AuthResponse>(
        { success: false, error: '密码长度至少 6 个字符' },
        { status: 400 }
      );
    }

    if (action === 'register') {
      // 注册
      const { inviteCode } = body;

      // 验证邀请码
      if (!inviteCode) {
        return NextResponse.json<AuthResponse>(
          { success: false, error: '请输入邀请码' },
          { status: 400 }
        );
      }

      if (!inviteCodeQueries.isValid(inviteCode)) {
        return NextResponse.json<AuthResponse>(
          { success: false, error: '邀请码无效或已被使用' },
          { status: 400 }
        );
      }

      const existingUser = userQueries.findByUsername(username);
      if (existingUser) {
        return NextResponse.json<AuthResponse>(
          { success: false, error: '用户名已存在' },
          { status: 400 }
        );
      }

      const passwordHash = await hashPassword(password);
      const userId = userQueries.create(username, passwordHash, inviteCode);

      // 标记邀请码已使用
      inviteCodeQueries.use(inviteCode, userId);

      const token = await generateToken(userId, username);

      return NextResponse.json<AuthResponse>({
        success: true,
        token,
        user: {
          id: userId,
          username,
          role: 'user',
          createdAt: new Date().toISOString(),
        },
      });
    } else {
      // 登录
      const user = userQueries.findByUsername(username);
      if (!user) {
        return NextResponse.json<AuthResponse>(
          { success: false, error: '用户名或密码错误' },
          { status: 401 }
        );
      }

      const isValid = await verifyPassword(password, user.password_hash);
      if (!isValid) {
        return NextResponse.json<AuthResponse>(
          { success: false, error: '用户名或密码错误' },
          { status: 401 }
        );
      }

      const token = await generateToken(user.id, user.username);

      return NextResponse.json<AuthResponse>({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role as UserRole,
          createdAt: user.created_at,
        },
      });
    }
  } catch (error) {
    console.error('Auth error:', error);
    return NextResponse.json<AuthResponse>(
      { success: false, error: '服务器错误' },
      { status: 500 }
    );
  }
}
