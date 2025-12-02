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

// 下单到 Binance
async function placeBinanceOrder(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET';
    quantity: number;
    price?: number;
  }
) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();

  // 构建查询参数
  const queryParams: Record<string, string | number> = {
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    quantity: params.quantity,
    timestamp,
  };

  // 限价单需要价格和 timeInForce
  if (params.type === 'LIMIT' && params.price) {
    queryParams.price = params.price;
    queryParams.timeInForce = 'GTC';
  }

  const queryString = Object.entries(queryParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const signature = generateBinanceSignature(queryString, apiSecret);

  const url = `${baseUrl}/fapi/v1/order`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `${queryString}&signature=${signature}`,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.msg || '下单失败');
  }

  return {
    success: true,
    order: {
      orderId: data.orderId,
      symbol: data.symbol,
      side: data.side,
      type: data.type,
      price: data.price,
      quantity: data.origQty,
      status: data.status,
      time: data.updateTime,
    },
  };
}

// 取消订单
async function cancelBinanceOrder(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string,
  orderId: number
) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
  const signature = generateBinanceSignature(queryString, apiSecret);

  const url = `${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.msg || '取消订单失败');
  }

  return {
    success: true,
    message: '订单已取消',
    orderId: data.orderId,
  };
}

// POST /api/user/order - 下单
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const { symbol, side, type, quantity, price } = await request.json();

    // 参数验证
    if (!symbol) {
      return NextResponse.json({ error: '请指定交易对' }, { status: 400 });
    }
    if (!side || !['BUY', 'SELL'].includes(side)) {
      return NextResponse.json({ error: '请指定正确的交易方向 (BUY/SELL)' }, { status: 400 });
    }
    if (!type || !['LIMIT', 'MARKET'].includes(type)) {
      return NextResponse.json({ error: '请指定正确的订单类型 (LIMIT/MARKET)' }, { status: 400 });
    }
    if (!quantity || quantity <= 0) {
      return NextResponse.json({ error: '请指定有效的数量' }, { status: 400 });
    }
    if (type === 'LIMIT' && (!price || price <= 0)) {
      return NextResponse.json({ error: '限价单请指定价格' }, { status: 400 });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    const result = await placeBinanceOrder(config.apiKey, config.apiSecret, config.isTestnet, {
      symbol,
      side,
      type,
      quantity,
      price,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Place order error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '下单失败',
    }, { status: 500 });
  }
}

// DELETE /api/user/order - 取消订单
export async function DELETE(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');
    const orderId = searchParams.get('orderId');

    if (!symbol) {
      return NextResponse.json({ error: '请指定交易对' }, { status: 400 });
    }
    if (!orderId) {
      return NextResponse.json({ error: '请指定订单ID' }, { status: 400 });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    const result = await cancelBinanceOrder(
      config.apiKey,
      config.apiSecret,
      config.isTestnet,
      symbol,
      parseInt(orderId)
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error('Cancel order error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '取消订单失败',
    }, { status: 500 });
  }
}
