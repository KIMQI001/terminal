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

// 获取普通挂单列表
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

// 获取 Algo 条件单列表（止损/止盈/追踪止盈）
async function getBinanceAlgoOrders(
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

  // 正确端点: /fapi/v1/openAlgoOrders
  const url = `${baseUrl}/fapi/v1/openAlgoOrders?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    // Algo API 可能返回空或错误，不抛出异常
    console.warn('获取 Algo 订单警告:', data.msg);
    return [];
  }

  // API 直接返回数组，不是 { orders: [...] }
  const orders = Array.isArray(data) ? data : (data.orders || []);
  console.log('[AlgoOrders] 订单数量:', orders.length);
  return orders;
}

// GET /api/user/orders - 获取挂单列表（包括普通订单和 Algo 条件单）
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

    console.log('[Orders] 查询 symbol:', symbol, 'isTestnet:', config.isTestnet);

    // 并行获取普通订单和 Algo 条件单
    const [normalOrders, algoOrders] = await Promise.all([
      getBinanceOpenOrders(config.apiKey, config.apiSecret, config.isTestnet, symbol),
      getBinanceAlgoOrders(config.apiKey, config.apiSecret, config.isTestnet, symbol),
    ]);

    console.log('[Orders] 普通订单数:', normalOrders.length, 'Algo订单数:', algoOrders.length);

    // 格式化普通订单
    const formattedNormalOrders = normalOrders.map((order: {
      orderId: number;
      clientOrderId: string;
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
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side.toLowerCase(),
      positionSide: order.positionSide,
      type: order.type.toLowerCase().replace('_', '-'),
      quantity: parseFloat(order.origQty),
      price: parseFloat(order.price) || undefined,
      stopPrice: parseFloat(order.stopPrice) || undefined,
      status: order.status.toLowerCase(),
      time: order.time,
      isAlgo: false,
    }));

    // 格式化 Algo 条件单
    const formattedAlgoOrders = algoOrders.map((order: {
      algoId: number;
      clientAlgoId: string;
      symbol: string;
      side: string;
      positionSide: string;
      orderType: string;        // API 返回的是 orderType，不是 type
      quantity: string;
      triggerPrice?: string;
      activationPrice?: string;
      callbackRate?: string;
      algoStatus: string;       // API 返回的是 algoStatus，不是 status
      createTime: number;
    }) => ({
      id: order.algoId.toString(),
      clientOrderId: order.clientAlgoId || '',
      symbol: order.symbol,
      side: order.side.toLowerCase(),
      positionSide: order.positionSide,
      type: (order.orderType || 'STOP_MARKET').toLowerCase().replace('_', '-'),
      quantity: parseFloat(order.quantity),
      price: undefined,
      stopPrice: parseFloat(order.triggerPrice || '0') || parseFloat(order.activationPrice || '0') || undefined,
      status: (order.algoStatus || 'new').toLowerCase(),
      time: order.createTime,
      isAlgo: true,
      callbackRate: order.callbackRate ? parseFloat(order.callbackRate) : undefined,
    }));

    // 合并并按时间排序
    const allOrders = [...formattedNormalOrders, ...formattedAlgoOrders]
      .sort((a, b) => b.time - a.time);

    return NextResponse.json({ success: true, orders: allOrders });
  } catch (error) {
    console.error('Get open orders error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '获取挂单失败',
    }, { status: 500 });
  }
}
