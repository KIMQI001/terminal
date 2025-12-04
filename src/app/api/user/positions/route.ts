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

// 获取持仓
async function getBinancePositions(apiKey: string, apiSecret: string, isTestnet: boolean) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = generateBinanceSignature(queryString, apiSecret);

  const url = `${baseUrl}/fapi/v2/positionRisk?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.msg || '获取持仓失败');
  }

  return data;
}

// 获取当前挂单
async function getBinanceOpenOrders(apiKey: string, apiSecret: string, isTestnet: boolean, symbol?: string) {
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

// 市价平仓
async function closePositionMarket(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string,
  side: 'BUY' | 'SELL',
  positionSide: 'LONG' | 'SHORT',
  quantity: number
) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const params: Record<string, string | number> = {
    symbol,
    side,
    positionSide,
    type: 'MARKET',
    quantity: quantity.toFixed(3),
    timestamp,
  };

  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = generateBinanceSignature(queryString, apiSecret);

  const response = await fetch(`${baseUrl}/fapi/v1/order`, {
    method: 'POST',
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `${queryString}&signature=${signature}`,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.msg || '平仓失败');
  }

  return data;
}

// GET /api/user/positions - 获取持仓列表
export async function GET(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    // 并行获取持仓和挂单
    const [positions, openOrders] = await Promise.all([
      getBinancePositions(config.apiKey, config.apiSecret, config.isTestnet),
      getBinanceOpenOrders(config.apiKey, config.apiSecret, config.isTestnet),
    ]);

    // 过滤出有持仓的（positionAmt != 0）
    const activePositions = positions
      .filter((p: { positionAmt: string }) => parseFloat(p.positionAmt) !== 0)
      .map((p: {
        symbol: string;
        positionSide: string;
        positionAmt: string;
        entryPrice: string;
        markPrice: string;
        unRealizedProfit: string;
        leverage: string;
        liquidationPrice: string;
      }) => {
        const positionSide = p.positionSide;

        // 找到该仓位的止损单和止盈单
        const relatedOrders = openOrders.filter((o: { symbol: string; positionSide: string }) =>
          o.symbol === p.symbol && o.positionSide === positionSide
        );

        // 止损单 (STOP_MARKET)
        const stopLossOrder = relatedOrders.find((o: { type: string }) => o.type === 'STOP_MARKET');
        // 止盈单 (TAKE_PROFIT_MARKET 或 TRAILING_STOP_MARKET)
        const takeProfitOrder = relatedOrders.find((o: { type: string }) =>
          o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TRAILING_STOP_MARKET'
        );

        return {
          symbol: p.symbol,
          side: parseFloat(p.positionAmt) > 0 ? 'long' : 'short',
          positionSide: p.positionSide,
          quantity: Math.abs(parseFloat(p.positionAmt)),
          entryPrice: parseFloat(p.entryPrice),
          markPrice: parseFloat(p.markPrice),
          unrealizedPnl: parseFloat(p.unRealizedProfit),
          leverage: parseInt(p.leverage),
          liquidationPrice: parseFloat(p.liquidationPrice),
          stopLoss: stopLossOrder ? parseFloat(stopLossOrder.stopPrice) : null,
          takeProfit: takeProfitOrder ? parseFloat(takeProfitOrder.stopPrice) : null,
          takeProfitType: takeProfitOrder?.type || null,
        };
      });

    return NextResponse.json({ success: true, positions: activePositions });
  } catch (error) {
    console.error('Get positions error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '获取持仓失败',
    }, { status: 500 });
  }
}

// POST /api/user/positions - 市价平仓
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { symbol, positionSide, quantity } = body;

    if (!symbol || !positionSide || !quantity) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    // 平仓方向：多单平仓用 SELL，空单平仓用 BUY
    const closeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';

    const result = await closePositionMarket(
      config.apiKey,
      config.apiSecret,
      config.isTestnet,
      symbol,
      closeSide,
      positionSide,
      quantity
    );

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      message: '平仓成功',
    });
  } catch (error) {
    console.error('Close position error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '平仓失败',
    }, { status: 500 });
  }
}
