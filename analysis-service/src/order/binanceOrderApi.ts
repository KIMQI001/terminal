/**
 * Binance 下单 API 封装
 * 用于下止盈止损平仓限价单
 */

import crypto from 'crypto';

// 交易对精度配置
const SYMBOL_PRECISION: Record<string, { quantity: number; price: number }> = {
  'BTCUSDT': { quantity: 3, price: 1 },
  'ETHUSDT': { quantity: 3, price: 2 },
  'BNBUSDT': { quantity: 2, price: 2 },
  'SOLUSDT': { quantity: 0, price: 2 },
  'BTCUSDC': { quantity: 3, price: 1 },
  'ETHUSDC': { quantity: 3, price: 2 },
};

// 获取精度
function getPrecision(symbol: string): { quantity: number; price: number } {
  return SYMBOL_PRECISION[symbol] || { quantity: 3, price: 2 };
}

// 格式化数量
function formatQuantity(quantity: number, precision: number): string {
  return quantity.toFixed(precision);
}

// 格式化价格
function formatPrice(price: number, precision: number): string {
  return price.toFixed(precision);
}

// 生成签名
function generateSignature(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

export interface BinanceApiConfig {
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
}

export interface PlaceOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  quantity: number;
  price?: number;       // 限价单价格
  stopPrice?: number;   // 触发价格 (仅 STOP/TAKE_PROFIT)
  clientOrderId?: string;
  reduceOnly?: boolean; // 是否只减仓
}

export interface OrderResult {
  success: boolean;
  orderId?: number;
  clientOrderId?: string;
  status?: string;
  error?: string;
}

/**
 * 下单到 Binance Futures
 */
export async function placeOrder(
  config: BinanceApiConfig,
  params: PlaceOrderParams
): Promise<OrderResult> {
  const baseUrl = config.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const precision = getPrecision(params.symbol);

  // 构建请求参数
  const queryParams: Record<string, string | number> = {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: params.type,
    quantity: formatQuantity(params.quantity, precision.quantity),
    timestamp,
  };

  // 限价单需要价格和 timeInForce
  if (params.type === 'LIMIT' && params.price) {
    queryParams.price = formatPrice(params.price, precision.price);
    queryParams.timeInForce = 'GTC'; // Good Till Cancel
  }

  // 止盈止损单需要触发价格
  if ((params.type === 'STOP_MARKET' || params.type === 'TAKE_PROFIT_MARKET') && params.stopPrice) {
    queryParams.stopPrice = formatPrice(params.stopPrice, precision.price);
  }

  // 自定义订单 ID
  if (params.clientOrderId) {
    queryParams.newClientOrderId = params.clientOrderId;
  }

  // 只减仓标志
  if (params.reduceOnly) {
    queryParams.reduceOnly = 'true';
  }

  // 生成签名
  const queryString = Object.entries(queryParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/order`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    const data = await response.json() as { msg?: string; orderId?: number; clientOrderId?: string; status?: string };

    if (!response.ok) {
      return {
        success: false,
        error: data.msg || `HTTP ${response.status}`,
      };
    }

    return {
      success: true,
      orderId: data.orderId,
      clientOrderId: data.clientOrderId,
      status: data.status,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络请求失败',
    };
  }
}

/**
 * 下止损平仓限价单
 * 使用限价单而非 STOP_MARKET，手续费更低
 */
export async function placeStopLossOrder(
  config: BinanceApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';       // 平仓方向
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    stopPrice: number;          // 止损价格
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  // 使用限价单作为止损，价格稍微比触发价差一点以确保成交
  // 做多止损: 卖出，价格设为止损价 - 0.1%
  // 做空止损: 买入，价格设为止损价 + 0.1%
  const slippage = 0.001; // 0.1% 滑点
  const limitPrice = params.side === 'SELL'
    ? params.stopPrice * (1 - slippage)
    : params.stopPrice * (1 + slippage);

  return placeOrder(config, {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: 'LIMIT',
    quantity: params.quantity,
    price: limitPrice,
    clientOrderId: params.clientOrderId,
    reduceOnly: true,
  });
}

/**
 * 下止盈平仓限价单
 * 使用限价单，手续费更低
 */
export async function placeTakeProfitOrder(
  config: BinanceApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';       // 平仓方向
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    takeProfitPrice: number;    // 止盈价格
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  // 止盈用限价单，直接挂在目标价格
  return placeOrder(config, {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: 'LIMIT',
    quantity: params.quantity,
    price: params.takeProfitPrice,
    clientOrderId: params.clientOrderId,
    reduceOnly: true,
  });
}

/**
 * 取消订单
 */
export async function cancelOrder(
  config: BinanceApiConfig,
  symbol: string,
  orderId: number
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = config.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`, {
      method: 'DELETE',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
      },
    });

    const data = await response.json() as { msg?: string };

    if (!response.ok) {
      return {
        success: false,
        error: data.msg || `HTTP ${response.status}`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络请求失败',
    };
  }
}

/**
 * 获取当前价格
 */
export async function getCurrentPrice(
  config: BinanceApiConfig,
  symbol: string
): Promise<number | null> {
  const baseUrl = config.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`);
    const data = await response.json() as { price?: string };

    if (response.ok && data.price) {
      return parseFloat(data.price);
    }
    return null;
  } catch {
    return null;
  }
}
