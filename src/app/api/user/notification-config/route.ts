import { NextRequest, NextResponse } from 'next/server';
import { notificationConfigQueries } from '@/lib/db';
import { verifyToken, extractTokenFromHeader } from '@/lib/auth';
import { encrypt } from '@/lib/crypto';

// 验证用户身份
async function authenticateUser(request: NextRequest): Promise<{ userId: number; username: string } | null> {
  const authHeader = request.headers.get('Authorization');
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    return null;
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return null;
  }

  return { userId: payload.userId, username: payload.username };
}

// GET /api/user/notification-config - 获取用户的通知配置
export async function GET(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const config = notificationConfigQueries.findByUserId(user.userId);

    if (!config) {
      return NextResponse.json({
        config: {
          dingtalkWebhook: null,
          dingtalkSecret: null,
          enabled: true,
          positionMonitorEnabled: false,
        },
      });
    }

    // 不返回完整的 webhook 和 secret，只返回是否已配置
    return NextResponse.json({
      config: {
        dingtalkWebhook: config.dingtalk_webhook ? maskWebhook(config.dingtalk_webhook) : null,
        dingtalkSecretConfigured: !!config.dingtalk_secret_encrypted,
        enabled: config.enabled === 1,
        positionMonitorEnabled: config.position_monitor_enabled === 1,
      },
    });
  } catch (error) {
    console.error('Get notification config error:', error);
    return NextResponse.json({ error: '获取配置失败' }, { status: 500 });
  }
}

// POST /api/user/notification-config - 保存通知配置
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { dingtalkWebhook, dingtalkSecret, enabled, positionMonitorEnabled } = body;

    // 验证 Webhook URL 格式
    if (dingtalkWebhook && !dingtalkWebhook.startsWith('https://oapi.dingtalk.com/robot/send')) {
      return NextResponse.json({ error: '钉钉 Webhook URL 格式不正确' }, { status: 400 });
    }

    // 加密 Secret
    const dingtalkSecretEncrypted = dingtalkSecret ? encrypt(dingtalkSecret) : null;

    // 保存到数据库
    notificationConfigQueries.upsert(
      user.userId,
      dingtalkWebhook || null,
      dingtalkSecretEncrypted,
      enabled !== false,
      positionMonitorEnabled === true
    );

    return NextResponse.json({ success: true, message: '通知配置已保存' });
  } catch (error) {
    console.error('Save notification config error:', error);
    return NextResponse.json({ error: '保存配置失败' }, { status: 500 });
  }
}

// DELETE /api/user/notification-config - 删除通知配置
export async function DELETE(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    notificationConfigQueries.delete(user.userId);
    return NextResponse.json({ success: true, message: '通知配置已删除' });
  } catch (error) {
    console.error('Delete notification config error:', error);
    return NextResponse.json({ error: '删除配置失败' }, { status: 500 });
  }
}

// 掩码 Webhook URL，只显示部分内容
function maskWebhook(webhook: string): string {
  // https://oapi.dingtalk.com/robot/send?access_token=xxxx
  const match = webhook.match(/access_token=([a-zA-Z0-9]+)/);
  if (match) {
    const token = match[1];
    const masked = token.substring(0, 6) + '****' + token.substring(token.length - 4);
    return webhook.replace(token, masked);
  }
  return webhook;
}
