import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, extractTokenFromHeader } from '@/lib/auth';
import { getDecryptedApiConfig } from '@/lib/apiConfig';
import crypto from 'crypto';

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

// 生成 Binance API 签名
function generateBinanceSignature(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// 测试 Binance 连接
async function testBinanceConnection(apiKey: string, apiSecret: string, isTestnet: boolean) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = generateBinanceSignature(queryString, apiSecret);

  const url = `${baseUrl}/fapi/v2/account?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.msg || '连接失败');
  }

  const data = await response.json();

  // 提取余额信息
  const balances = data.assets
    ?.filter((asset: { walletBalance: string }) => parseFloat(asset.walletBalance) > 0)
    .map((asset: { asset: string; walletBalance: string; availableBalance: string }) => ({
      asset: asset.asset,
      free: asset.availableBalance,
      locked: (parseFloat(asset.walletBalance) - parseFloat(asset.availableBalance)).toFixed(8),
    })) || [];

  return { success: true, balance: balances };
}

// POST /api/user/test-connection - 测试 API 连接
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const { exchange } = await request.json();

    if (!exchange) {
      return NextResponse.json({ error: '请指定交易所' }, { status: 400 });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, exchange);
    if (!config) {
      return NextResponse.json({ error: '未找到该交易所的 API 配置' }, { status: 404 });
    }

    // 根据交易所类型测试连接
    let result;
    switch (exchange) {
      case 'binance':
        result = await testBinanceConnection(config.apiKey, config.apiSecret, config.isTestnet);
        break;
      case 'okx':
      case 'bitget':
      case 'hyperliquid':
        return NextResponse.json({ error: '该交易所暂不支持' }, { status: 400 });
      default:
        return NextResponse.json({ error: '不支持的交易所' }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Test connection error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '连接测试失败',
    }, { status: 500 });
  }
}
