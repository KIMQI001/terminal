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

// 延迟函数
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// analysis-service 地址
const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || 'http://127.0.0.1:3002';

// 保存待处理订单到 analysis-service（守塔订单成交后下止盈止损）
async function savePendingOrder(params: {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
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
      console.log(`[PendingOrder] 已保存待处理订单: ${params.clientOrderId}`);
      return true;
    } else {
      console.error(`[PendingOrder] 保存失败: ${data.error}`);
      return false;
    }
  } catch (error) {
    console.error('[PendingOrder] 保存待处理订单失败:', error);
    return false;
  }
}

// 获取当前市场价格
async function getCurrentPrice(symbol: string, isTestnet: boolean): Promise<number | null> {
  try {
    const baseUrl = isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    const response = await fetch(`${baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`);
    const data = await response.json();

    if (response.ok && data.price) {
      return parseFloat(data.price);
    }
    return null;
  } catch {
    return null;
  }
}

// 验证止盈止损价格是否有效（不会立即触发）
function validateStopPrice(
  currentPrice: number,
  stopPrice: number,
  side: 'BUY' | 'SELL',
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'
): boolean {
  // 止损单：
  // - 做多(BUY)的止损 -> 平多(SELL) -> 止损价 < 当前价
  // - 做空(SELL)的止损 -> 平空(BUY) -> 止损价 > 当前价
  // 止盈单：
  // - 做多(BUY)的止盈 -> 平多(SELL) -> 止盈价 > 当前价
  // - 做空(SELL)的止盈 -> 平空(BUY) -> 止盈价 < 当前价

  if (type === 'STOP_MARKET') {
    // 止损单的 side 是平仓方向
    if (side === 'SELL') {
      // 平多止损，价格需 < 当前价
      return stopPrice < currentPrice;
    } else {
      // 平空止损，价格需 > 当前价
      return stopPrice > currentPrice;
    }
  } else {
    // 止盈单
    if (side === 'SELL') {
      // 平多止盈，价格需 > 当前价
      return stopPrice > currentPrice;
    } else {
      // 平空止盈，价格需 < 当前价
      return stopPrice < currentPrice;
    }
  }
}

// 带重试的止盈止损单下单
async function placeStopOrderWithRetry(
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
    clientOrderId?: string;
  },
  maxRetries: number = 2,
  retryDelay: number = 500
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 重试时生成新的 clientOrderId（避免重复）
      const currentClientOrderId = attempt === 0
        ? params.clientOrderId
        : params.clientOrderId ? `${params.clientOrderId}_r${attempt}` : undefined;

      const data = await placeStopOrder(apiKey, apiSecret, isTestnet, {
        ...params,
        clientOrderId: currentClientOrderId,
      });

      return { success: true, data };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error('未知错误');
      console.warn(`[止盈止损] 第 ${attempt + 1} 次尝试失败:`, lastError.message);

      // 如果还有重试次数，等待后重试
      if (attempt < maxRetries) {
        await delay(retryDelay);
      }
    }
  }

  return {
    success: false,
    error: lastError?.message || '未知错误',
  };
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
    clientOrderId?: string;
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

  // 添加自定义订单 ID
  if (params.clientOrderId) {
    queryParams.newClientOrderId = params.clientOrderId;
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
    clientOrderIdPrefix?: string;
  }
) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const precision = getPrecision(params.symbol);

  // 生成自定义订单 ID（如果有前缀）
  // 新格式 ict_tower_{timeframe}_{source}_{price} 已包含完整信息，不加时间戳
  // 旧格式只有 ict_tower，需要加时间戳区分
  const clientOrderId = params.clientOrderIdPrefix
    ? (params.clientOrderIdPrefix.split('_').length >= 5
        ? params.clientOrderIdPrefix  // 新格式，直接使用
        : `${params.clientOrderIdPrefix}_${timestamp}`)  // 旧格式，加时间戳
    : undefined;

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

  // 添加自定义订单 ID
  if (clientOrderId) {
    queryParams.newClientOrderId = clientOrderId;
  }

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
      clientOrderId: data.clientOrderId || clientOrderId,
      symbol: data.symbol,
      side: data.side,
      type: data.type,
      price: data.price,
      quantity: data.origQty,
      status: data.status,
      time: data.updateTime,
    },
    stopOrders: [] as { type: string; orderId: number; clientOrderId?: string }[],
    warnings: [] as string[],
    pendingOrder: false, // 是否为待处理订单（成交后再下止盈止损）
  };

  // 守塔订单也立即下止盈止损单（STOP_MARKET / TAKE_PROFIT_MARKET）
  // 同时保存到待处理队列，成交后再下追踪止盈单
  const isTowerOrder = params.clientOrderIdPrefix?.startsWith('ict_tower');

  if (isTowerOrder && params.stopLoss && params.takeProfit && clientOrderId) {
    // 保存待处理订单到 analysis-service（成交后下追踪止盈）
    await savePendingOrder({
      clientOrderId,
      symbol: params.symbol,
      side: params.side,
      positionSide,
      quantity: params.quantity,
      entryPrice: params.price || 0,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
    });
    result.pendingOrder = true;
    console.log(`[Tower] 守塔订单已保存待处理: ${clientOrderId}`);
  }

  // 所有订单都下止盈止损单

  // 获取当前价格用于验证止盈止损
  const currentPrice = await getCurrentPrice(params.symbol, isTestnet);

  // 下止损单（带重试）
  if (params.stopLoss && params.stopLoss > 0) {
    const slSide = params.side === 'BUY' ? 'SELL' : 'BUY';
    const slClientOrderId = clientOrderId ? `${clientOrderId}_sl` : undefined;

    // 验证止损价格是否有效
    if (currentPrice && !validateStopPrice(currentPrice, params.stopLoss, slSide, 'STOP_MARKET')) {
      console.warn(`[止损] 价格无效，跳过: 当前价=${currentPrice}, 止损价=${params.stopLoss}, 方向=${slSide}`);
      result.warnings.push(`止损单跳过: 价格会立即触发 (当前${currentPrice.toFixed(1)}, 止损${params.stopLoss.toFixed(1)})`);
    } else {
      const slResult = await placeStopOrderWithRetry(apiKey, apiSecret, isTestnet, {
        symbol: params.symbol,
        side: slSide,
        positionSide,
        type: 'STOP_MARKET',
        quantity: params.quantity,
        stopPrice: params.stopLoss,
        clientOrderId: slClientOrderId,
      });

      if (slResult.success && slResult.data) {
        const slData = slResult.data as { orderId: number; clientOrderId?: string };
        result.stopOrders.push({
          type: 'stopLoss',
          orderId: slData.orderId,
          clientOrderId: slData.clientOrderId || slClientOrderId,
        });
      } else {
        console.error('Stop loss order failed after retries:', slResult.error);
        result.warnings.push(`止损单失败: ${slResult.error}`);
      }
    }
  }

  // 下止盈单（带重试）
  if (params.takeProfit && params.takeProfit > 0) {
    const tpSide = params.side === 'BUY' ? 'SELL' : 'BUY';
    const tpClientOrderId = clientOrderId ? `${clientOrderId}_tp` : undefined;

    // 验证止盈价格是否有效
    if (currentPrice && !validateStopPrice(currentPrice, params.takeProfit, tpSide, 'TAKE_PROFIT_MARKET')) {
      console.warn(`[止盈] 价格无效，跳过: 当前价=${currentPrice}, 止盈价=${params.takeProfit}, 方向=${tpSide}`);
      result.warnings.push(`止盈单跳过: 价格会立即触发 (当前${currentPrice.toFixed(1)}, 止盈${params.takeProfit.toFixed(1)})`);
    } else {
      const tpResult = await placeStopOrderWithRetry(apiKey, apiSecret, isTestnet, {
        symbol: params.symbol,
        side: tpSide,
        positionSide,
        type: 'TAKE_PROFIT_MARKET',
        quantity: params.quantity,
        stopPrice: params.takeProfit,
        clientOrderId: tpClientOrderId,
      });

      if (tpResult.success && tpResult.data) {
        const tpData = tpResult.data as { orderId: number; clientOrderId?: string };
        result.stopOrders.push({
          type: 'takeProfit',
          orderId: tpData.orderId,
          clientOrderId: tpData.clientOrderId || tpClientOrderId,
        });
      } else {
        console.error('Take profit order failed after retries:', tpResult.error);
        result.warnings.push(`止盈单失败: ${tpResult.error}`);
      }
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

// 取消所有订单
async function cancelAllBinanceOrders(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string
) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = generateBinanceSignature(queryString, apiSecret);

  const url = `${baseUrl}/fapi/v1/allOpenOrders?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.msg || '取消全部订单失败');
  }

  return {
    success: true,
    message: '全部订单已取消',
  };
}

// POST /api/user/order - 下单
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const { symbol, side, type, quantity, price, stopLoss, takeProfit, clientOrderIdPrefix } = await request.json();

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
      clientOrderIdPrefix,
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
    const cancelAll = searchParams.get('cancelAll');

    if (!symbol) {
      return NextResponse.json({ error: '请指定交易对' }, { status: 400 });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    // 取消全部订单
    if (cancelAll === 'true') {
      const result = await cancelAllBinanceOrders(
        config.apiKey,
        config.apiSecret,
        config.isTestnet,
        symbol
      );
      return NextResponse.json(result);
    }

    // 取消单个订单
    if (!orderId) {
      return NextResponse.json({ error: '请指定订单ID' }, { status: 400 });
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
