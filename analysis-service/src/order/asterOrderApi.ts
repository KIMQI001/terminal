/**
 * Aster DEX 下单 API 封装
 * 基于 Binance 兼容 API (fapi.asterdex.com)
 */

import crypto from 'crypto';

// 交易对精度配置
const SYMBOL_PRECISION: Record<string, { quantity: number; price: number }> = {
  'BTCUSDT': { quantity: 3, price: 1 },
  'ETHUSDT': { quantity: 3, price: 2 },
  'BNBUSDT': { quantity: 2, price: 2 },
  'SOLUSDT': { quantity: 0, price: 2 },
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

// 生成签名 (与 Binance 相同的 HMAC SHA256)
function generateSignature(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

export interface AsterApiConfig {
  apiKey: string;
  apiSecret: string;
}

export interface PlaceOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET';
  quantity: number;
  price?: number;
  stopPrice?: number;
  callbackRate?: number;
  activationPrice?: number;
  clientOrderId?: string;
  reduceOnly?: boolean;
}

export interface OrderResult {
  success: boolean;
  orderId?: number;
  clientOrderId?: string;
  status?: string;
  error?: string;
}

const BASE_URL = 'https://fapi.asterdex.com';

/**
 * 下单到 Aster DEX
 */
export async function placeOrder(
  config: AsterApiConfig,
  params: PlaceOrderParams
): Promise<OrderResult> {
  const timestamp = Date.now();
  const precision = getPrecision(params.symbol);

  const queryParams: Record<string, string | number> = {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: params.type,
    quantity: formatQuantity(params.quantity, precision.quantity),
    timestamp,
  };

  if (params.type === 'LIMIT' && params.price) {
    queryParams.price = formatPrice(params.price, precision.price);
    queryParams.timeInForce = 'GTC';
  }

  if ((params.type === 'STOP_MARKET' || params.type === 'TAKE_PROFIT_MARKET') && params.stopPrice) {
    queryParams.stopPrice = formatPrice(params.stopPrice, precision.price);
  }

  if (params.type === 'TRAILING_STOP_MARKET') {
    if (params.callbackRate) {
      queryParams.callbackRate = params.callbackRate;
    }
    if (params.activationPrice) {
      queryParams.activatePrice = formatPrice(params.activationPrice, precision.price);
    }
  }

  if (params.clientOrderId) {
    queryParams.newClientOrderId = params.clientOrderId;
  }

  if (params.reduceOnly && !params.positionSide) {
    queryParams.reduceOnly = 'true';
  }

  const queryString = Object.entries(queryParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${BASE_URL}/fapi/v3/order`, {
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
 * 下止损单 (STOP_MARKET)
 */
export async function placeStopLossOrder(
  config: AsterApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    stopPrice: number;
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  return placeOrder(config, {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: 'STOP_MARKET',
    quantity: params.quantity,
    stopPrice: params.stopPrice,
    clientOrderId: params.clientOrderId,
  });
}

/**
 * 下止盈限价单
 */
export async function placeTakeProfitOrder(
  config: AsterApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    takeProfitPrice: number;
    clientOrderId?: string;
  }
): Promise<OrderResult> {
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
 * 下追踪止盈单
 */
export async function placeTrailingStopOrder(
  config: AsterApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    callbackRate: number;
    activationPrice?: number;
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  return placeOrder(config, {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: 'TRAILING_STOP_MARKET',
    quantity: params.quantity,
    callbackRate: params.callbackRate,
    activationPrice: params.activationPrice,
    clientOrderId: params.clientOrderId,
  });
}

/**
 * 取消订单
 */
export async function cancelOrder(
  config: AsterApiConfig,
  symbol: string,
  orderId: number
): Promise<{ success: boolean; error?: string }> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${BASE_URL}/fapi/v3/order?${queryString}&signature=${signature}`, {
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
 * 根据 clientOrderId 取消订单
 */
export async function cancelOrderByClientId(
  config: AsterApiConfig,
  symbol: string,
  clientOrderId: string
): Promise<{ success: boolean; error?: string }> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&origClientOrderId=${clientOrderId}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${BASE_URL}/fapi/v3/order?${queryString}&signature=${signature}`, {
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
  config: AsterApiConfig,
  symbol: string
): Promise<number | null> {
  try {
    const response = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
    const data = await response.json() as { price?: string };

    if (response.ok && data.price) {
      return parseFloat(data.price);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 市价平仓
 */
export async function closePositionMarket(
  config: AsterApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  return placeOrder(config, {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: 'MARKET',
    quantity: params.quantity,
    clientOrderId: params.clientOrderId,
    reduceOnly: true,
  });
}

/**
 * 仓位信息接口
 */
export interface PositionInfo {
  symbol: string;
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  marginType: string;
  isolatedMargin: number;
}

/**
 * 获取所有持仓
 */
export async function getPositions(
  config: AsterApiConfig,
  symbol?: string
): Promise<{ success: boolean; positions?: PositionInfo[]; error?: string }> {
  const timestamp = Date.now();
  let queryString = `timestamp=${timestamp}`;
  if (symbol) {
    queryString = `symbol=${symbol}&${queryString}`;
  }
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${BASE_URL}/fapi/v3/positionRisk?${queryString}&signature=${signature}`, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
      },
    });

    const data = await response.json() as Array<{
      symbol: string;
      positionSide: string;
      positionAmt: string;
      entryPrice: string;
      markPrice: string;
      unRealizedProfit: string;
      liquidationPrice: string;
      leverage: string;
      marginType: string;
      isolatedMargin: string;
    }> | { msg?: string };

    if (!response.ok) {
      return {
        success: false,
        error: (data as { msg?: string }).msg || `HTTP ${response.status}`,
      };
    }

    const positions = (data as Array<{
      symbol: string;
      positionSide: string;
      positionAmt: string;
      entryPrice: string;
      markPrice: string;
      unRealizedProfit: string;
      liquidationPrice: string;
      leverage: string;
      marginType: string;
      isolatedMargin: string;
    }>)
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        positionSide: p.positionSide as 'LONG' | 'SHORT' | 'BOTH',
        positionAmt: parseFloat(p.positionAmt),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        unRealizedProfit: parseFloat(p.unRealizedProfit),
        liquidationPrice: parseFloat(p.liquidationPrice),
        leverage: parseInt(p.leverage),
        marginType: p.marginType,
        isolatedMargin: parseFloat(p.isolatedMargin),
      }));

    return { success: true, positions };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络请求失败',
    };
  }
}

/**
 * 挂单信息接口
 */
export interface OpenOrderInfo {
  orderId: number;
  symbol: string;
  clientOrderId: string;
  price: number;
  origQty: number;
  executedQty: number;
  status: string;
  type: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  stopPrice: number;
  workingType: string;
  time: number;
}

/**
 * 获取当前挂单
 */
export async function getOpenOrders(
  config: AsterApiConfig,
  symbol?: string
): Promise<{ success: boolean; orders?: OpenOrderInfo[]; error?: string }> {
  const timestamp = Date.now();
  let queryString = `timestamp=${timestamp}`;
  if (symbol) {
    queryString = `symbol=${symbol}&${queryString}`;
  }
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${BASE_URL}/fapi/v3/openOrders?${queryString}&signature=${signature}`, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
      },
    });

    const data = await response.json() as Array<{
      orderId: number;
      symbol: string;
      clientOrderId: string;
      price: string;
      origQty: string;
      executedQty: string;
      status: string;
      type: string;
      side: string;
      positionSide: string;
      stopPrice: string;
      workingType: string;
      time: number;
    }> | { msg?: string };

    if (!response.ok) {
      return {
        success: false,
        error: (data as { msg?: string }).msg || `HTTP ${response.status}`,
      };
    }

    const orders = (data as Array<{
      orderId: number;
      symbol: string;
      clientOrderId: string;
      price: string;
      origQty: string;
      executedQty: string;
      status: string;
      type: string;
      side: string;
      positionSide: string;
      stopPrice: string;
      workingType: string;
      time: number;
    }>).map(o => ({
      orderId: o.orderId,
      symbol: o.symbol,
      clientOrderId: o.clientOrderId,
      price: parseFloat(o.price),
      origQty: parseFloat(o.origQty),
      executedQty: parseFloat(o.executedQty),
      status: o.status,
      type: o.type,
      side: o.side as 'BUY' | 'SELL',
      positionSide: o.positionSide as 'LONG' | 'SHORT' | 'BOTH',
      stopPrice: parseFloat(o.stopPrice),
      workingType: o.workingType,
      time: o.time,
    }));

    return { success: true, orders };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络请求失败',
    };
  }
}

/**
 * 设置杠杆倍数
 */
export async function setLeverage(
  config: AsterApiConfig,
  symbol: string,
  leverage: number
): Promise<{ success: boolean; error?: string }> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${BASE_URL}/fapi/v3/leverage`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
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
