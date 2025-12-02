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

// 获取挂单列表
async function getBinanceOpenOrders(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol?: string
) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  let queryString = `timestamp=${timestamp}`;
  if (symbol) {
    queryString = `symbol=${symbol}&${queryString}`;
  }

  const signature = generateBinanceSignature(queryString, apiSecret);

  const url = `${baseUrl}/fapi/v1/openOrders?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.msg || '获取挂单失败');
  }

  return data;
}

// GET /api/user/orders - 获取挂单列表
export async function GET(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || undefined;

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    const orders = await getBinanceOpenOrders(config.apiKey, config.apiSecret, config.isTestnet, symbol);

    // 格式化订单数据
    const formattedOrders = orders.map((order: {
      orderId: number;
      symbol: string;
      side: string;
      positionSide: string;
      type: string;
      origQty: string;
      price: string;
      stopPrice: string;
      status: string;
      time: number;
    }) => ({
      id: order.orderId.toString(),
      symbol: order.symbol,
      side: order.side.toLowerCase(),
      positionSide: order.positionSide,
      type: order.type.toLowerCase().replace('_', '-'),
      quantity: parseFloat(order.origQty),
      price: parseFloat(order.price) || undefined,
      stopPrice: parseFloat(order.stopPrice) || undefined,
      status: order.status.toLowerCase(),
      time: order.time,
    }));

    return NextResponse.json({ success: true, orders: formattedOrders });
  } catch (error) {
    console.error('Get open orders error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '获取挂单失败',
    }, { status: 500 });
  }
}
