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

// 交易对精度配置（常用交易对）
const SYMBOL_PRECISION: Record<string, { quantity: number; price: number }> = {
  'BTCUSDT': { quantity: 3, price: 1 },
  'ETHUSDT': { quantity: 3, price: 2 },
  'BNBUSDT': { quantity: 2, price: 2 },
  'SOLUSDT': { quantity: 0, price: 2 },
  'XRPUSDT': { quantity: 1, price: 4 },
  'DOGEUSDT': { quantity: 0, price: 5 },
  'ADAUSDT': { quantity: 0, price: 4 },
  'AVAXUSDT': { quantity: 1, price: 2 },
  'DOTUSDT': { quantity: 1, price: 3 },
  'LINKUSDT': { quantity: 1, price: 3 },
  'MATICUSDT': { quantity: 0, price: 4 },
  'LTCUSDT': { quantity: 2, price: 2 },
  'BTCUSDC': { quantity: 3, price: 1 },
  'ETHUSDC': { quantity: 3, price: 2 },
};

// 获取精度，默认使用安全值
function getPrecision(symbol: string) {
  return SYMBOL_PRECISION[symbol] || { quantity: 3, price: 2 };
}

// 格式化数量和价格
function formatQuantity(quantity: number, precision: number): string {
  return quantity.toFixed(precision);
}

function formatPrice(price: number, precision: number): string {
  return price.toFixed(precision);
}

// 下止盈止损单
async function placeStopOrder(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity: number;
    stopPrice: number;
  }
) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const precision = getPrecision(params.symbol);

  const queryParams: Record<string, string | number> = {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: params.type,
    quantity: formatQuantity(params.quantity, precision.quantity),
    stopPrice: formatPrice(params.stopPrice, precision.price),
    timestamp,
  };

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
    throw new Error(data.msg || '止盈止损单失败');
  }

  return data;
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
    stopLoss?: number;
    takeProfit?: number;
  }
) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const precision = getPrecision(params.symbol);

  // 根据交易方向确定持仓方向（双向持仓模式）
  // BUY 开多 -> LONG, SELL 开空 -> SHORT
  const positionSide = params.side === 'BUY' ? 'LONG' : 'SHORT';

  // 构建查询参数（使用格式化后的数量）
  const queryParams: Record<string, string | number> = {
    symbol: params.symbol,
    side: params.side,
    positionSide,
    type: params.type,
    quantity: formatQuantity(params.quantity, precision.quantity),
    timestamp,
  };

  // 限价单需要价格和 timeInForce
  if (params.type === 'LIMIT' && params.price) {
    queryParams.price = formatPrice(params.price, precision.price);
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

  const result = {
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
    stopOrders: [] as { type: string; orderId: number }[],
  };

  // 下止损单
  if (params.stopLoss && params.stopLoss > 0) {
    try {
      // 止损单：多单用 SELL 平仓，空单用 BUY 平仓
      const slSide = params.side === 'BUY' ? 'SELL' : 'BUY';
      const slData = await placeStopOrder(apiKey, apiSecret, isTestnet, {
        symbol: params.symbol,
        side: slSide,
        positionSide,
        type: 'STOP_MARKET',
        quantity: params.quantity,
        stopPrice: params.stopLoss,
      });
      result.stopOrders.push({ type: 'stopLoss', orderId: slData.orderId });
    } catch (e) {
      console.error('Stop loss order failed:', e);
    }
  }

  // 下止盈单
  if (params.takeProfit && params.takeProfit > 0) {
    try {
      // 止盈单：多单用 SELL 平仓，空单用 BUY 平仓
      const tpSide = params.side === 'BUY' ? 'SELL' : 'BUY';
      const tpData = await placeStopOrder(apiKey, apiSecret, isTestnet, {
        symbol: params.symbol,
        side: tpSide,
        positionSide,
        type: 'TAKE_PROFIT_MARKET',
        quantity: params.quantity,
        stopPrice: params.takeProfit,
      });
      result.stopOrders.push({ type: 'takeProfit', orderId: tpData.orderId });
    } catch (e) {
      console.error('Take profit order failed:', e);
    }
  }

  return result;
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
    const { symbol, side, type, quantity, price, stopLoss, takeProfit } = await request.json();

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
      stopLoss,
      takeProfit,
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
