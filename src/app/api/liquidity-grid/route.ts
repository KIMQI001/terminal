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

// 交易对精度配置
const SYMBOL_PRECISION: Record<string, { quantity: number; price: number }> = {
  'BTCUSDT': { quantity: 3, price: 1 },
  'ETHUSDT': { quantity: 3, price: 2 },
  'BTCUSDC': { quantity: 3, price: 1 },
  'ETHUSDC': { quantity: 3, price: 2 },
};

function getPrecision(symbol: string) {
  return SYMBOL_PRECISION[symbol] || { quantity: 3, price: 2 };
}

function formatQuantity(quantity: number, precision: number): string {
  return quantity.toFixed(precision);
}

function formatPrice(price: number, precision: number): string {
  return price.toFixed(precision);
}

// analysis-service 地址
const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || 'http://127.0.0.1:3002';

// 保存待处理订单到 analysis-service
async function savePendingOrder(params: {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  stopLoss: number;  // 0 表示无止损
  takeProfit: number;
}): Promise<boolean> {
  try {
    const response = await fetch(`${ANALYSIS_SERVICE_URL}/api/pending-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json();
    if (data.success) {
      console.log(`[LiqGrid] 已保存待处理订单: ${params.clientOrderId}`);
      return true;
    } else {
      console.error(`[LiqGrid] 保存失败: ${data.error}`);
      return false;
    }
  } catch (error) {
    console.error('[LiqGrid] 保存待处理订单失败:', error);
    return false;
  }
}

// 设置杠杆
async function setLeverage(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string,
  leverage: number
): Promise<boolean> {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`;
  const signature = generateBinanceSignature(queryString, apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/leverage`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    const data = await response.json();
    if (response.ok) {
      console.log(`[LiqGrid] 杠杆设置成功: ${symbol} ${leverage}x`);
      return true;
    } else {
      console.warn(`[LiqGrid] 杠杆设置失败: ${data.msg}`);
      return false;
    }
  } catch {
    return false;
  }
}

// 下限价单
async function placeLimitOrder(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    clientOrderId: string;
  }
): Promise<{ success: boolean; orderId?: number; clientOrderId?: string; error?: string }> {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const precision = getPrecision(params.symbol);
  const positionSide = params.side === 'BUY' ? 'LONG' : 'SHORT';

  const queryParams: Record<string, string | number> = {
    symbol: params.symbol,
    side: params.side,
    positionSide,
    type: 'LIMIT',
    quantity: formatQuantity(params.quantity, precision.quantity),
    price: formatPrice(params.price, precision.price),
    timeInForce: 'GTC',
    newClientOrderId: params.clientOrderId,
    timestamp,
  };

  const queryString = Object.entries(queryParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const signature = generateBinanceSignature(queryString, apiSecret);

  try {
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
      return { success: false, error: data.msg || '下单失败' };
    }

    return {
      success: true,
      orderId: data.orderId,
      clientOrderId: data.clientOrderId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络错误',
    };
  }
}

// POST /api/liquidity-grid - 批量下单
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const { symbol, leverage, amountPerOrder, orders } = await request.json();

    // 参数验证
    if (!symbol) {
      return NextResponse.json({ error: '请指定交易对' }, { status: 400 });
    }
    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return NextResponse.json({ error: '请提供订单列表' }, { status: 400 });
    }
    if (!amountPerOrder || amountPerOrder <= 0) {
      return NextResponse.json({ error: '请指定有效的每单金额' }, { status: 400 });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    // 设置杠杆
    if (leverage && leverage > 0) {
      await setLeverage(config.apiKey, config.apiSecret, config.isTestnet, symbol, leverage);
    }

    const results: Array<{
      success: boolean;
      orderId?: number;
      clientOrderId?: string;
      entryPrice: number;
      side: string;
      error?: string;
    }> = [];

    const precision = getPrecision(symbol);

    // 循环下单
    for (const order of orders) {
      const { entryPrice, side, tpPrice } = order;

      if (!entryPrice || !side || !tpPrice) {
        results.push({
          success: false,
          entryPrice: entryPrice || 0,
          side: side || 'UNKNOWN',
          error: '订单参数不完整',
        });
        continue;
      }

      // 计算数量：金额 / 价格
      const quantity = amountPerOrder / entryPrice;
      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';

      // 生成 clientOrderId
      const timestamp = Date.now();
      const priceStr = entryPrice.toFixed(precision.price).replace('.', '');
      const clientOrderId = `liq_grid_${side.toLowerCase()}_${priceStr}_${timestamp}`;

      // 下限价单
      const result = await placeLimitOrder(config.apiKey, config.apiSecret, config.isTestnet, {
        symbol,
        side,
        quantity,
        price: entryPrice,
        clientOrderId,
      });

      if (result.success) {
        // 保存到待处理订单表（成交后下止盈单）
        await savePendingOrder({
          clientOrderId,
          symbol,
          side,
          positionSide,
          quantity,
          entryPrice,
          stopLoss: 0,  // 无止损
          takeProfit: tpPrice,
        });

        results.push({
          success: true,
          orderId: result.orderId,
          clientOrderId: result.clientOrderId,
          entryPrice,
          side,
        });
      } else {
        results.push({
          success: false,
          entryPrice,
          side,
          error: result.error,
        });
      }

      // 避免请求过快
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return NextResponse.json({
      success: true,
      message: `成功 ${successCount} 个，失败 ${failCount} 个`,
      results,
    });
  } catch (error) {
    console.error('[LiqGrid] Error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '批量下单失败',
    }, { status: 500 });
  }
}
