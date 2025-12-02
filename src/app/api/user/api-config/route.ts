import { NextRequest, NextResponse } from 'next/server';
import { apiConfigQueries } from '@/lib/db';
import { verifyToken, extractTokenFromHeader } from '@/lib/auth';
import { encrypt, maskApiKey } from '@/lib/crypto';
import { SaveApiConfigRequest, ApiConfigDisplay, ExchangeType } from '@/types/user';

// 验证用户身份的中间件
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

// GET /api/user/api-config - 获取用户的 API 配置列表
export async function GET(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const configs = apiConfigQueries.findByUserId(user.userId);

    const displayConfigs: ApiConfigDisplay[] = configs.map((config) => ({
      exchange: config.exchange as ExchangeType,
      apiKey: maskApiKey(config.api_key),
      isTestnet: config.is_testnet === 1,
      permissions: config.permissions ? JSON.parse(config.permissions) : undefined,
    }));

    return NextResponse.json({ configs: displayConfigs });
  } catch (error) {
    console.error('Get API config error:', error);
    return NextResponse.json({ error: '获取配置失败' }, { status: 500 });
  }
}

// POST /api/user/api-config - 保存 API 配置
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const body: SaveApiConfigRequest = await request.json();
    const { exchange, apiKey, apiSecret, passphrase, isTestnet } = body;

    // 验证必填字段
    if (!exchange || !apiKey || !apiSecret) {
      return NextResponse.json({ error: 'API Key 和 Secret 不能为空' }, { status: 400 });
    }

    // 验证交易所类型
    const validExchanges: ExchangeType[] = ['binance', 'okx', 'bitget', 'hyperliquid'];
    if (!validExchanges.includes(exchange)) {
      return NextResponse.json({ error: '不支持的交易所' }, { status: 400 });
    }

    // 加密敏感信息
    const apiSecretEncrypted = encrypt(apiSecret);
    const passphraseEncrypted = passphrase ? encrypt(passphrase) : null;

    // 保存到数据库
    apiConfigQueries.upsert(
      user.userId,
      exchange,
      apiKey,
      apiSecretEncrypted,
      passphraseEncrypted,
      isTestnet,
      null // permissions 暂时不设置
    );

    return NextResponse.json({ success: true, message: 'API 配置已保存' });
  } catch (error) {
    console.error('Save API config error:', error);
    return NextResponse.json({ error: '保存配置失败' }, { status: 500 });
  }
}

// DELETE /api/user/api-config - 删除 API 配置
export async function DELETE(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const exchange = searchParams.get('exchange');

    if (!exchange) {
      return NextResponse.json({ error: '请指定交易所' }, { status: 400 });
    }

    apiConfigQueries.delete(user.userId, exchange);

    return NextResponse.json({ success: true, message: 'API 配置已删除' });
  } catch (error) {
    console.error('Delete API config error:', error);
    return NextResponse.json({ error: '删除配置失败' }, { status: 500 });
  }
}
