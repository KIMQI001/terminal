/**
 * 交易所适配器
 * 统一 Binance 和 Aster 的 API 接口
 */

import crypto from 'crypto';
import * as asterApi from './asterOrderApi';

// 交易所类型
export type ExchangeType = 'binance' | 'aster';

// 统一的 API 配置接口
export interface ExchangeApiConfig {
  apiKey: string;
  apiSecret: string;
  isTestnet?: boolean;
}

// 统一的持仓信息
export interface Position {
  symbol: string;
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  positionAmt: number;
  entryPrice: number;
  notional: number;
  leverage: number;
}

// 统一的挂单信息
export interface OpenOrder {
  orderId: number;
  symbol: string;
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  price: number;
  origQty: string;
  type: string;
  status: string;
}

// 统一的下单结果
export interface OrderResult {
  success: boolean;
  orderId?: number;
  clientOrderId?: string;
  error?: string;
}

// 交易对精度配置
const SYMBOL_PRECISION: Record<string, { quantity: number; price: number }> = {
  'BTCUSDT': { quantity: 3, price: 1 },
  'ETHUSDT': { quantity: 3, price: 2 },
  'BTCUSDC': { quantity: 3, price: 1 },
  'ETHUSDC': { quantity: 3, price: 2 },
  'BNBUSDT': { quantity: 2, price: 2 },
  'SOLUSDT': { quantity: 0, price: 2 },
};

function getPrecision(symbol: string) {
  return SYMBOL_PRECISION[symbol] || { quantity: 3, price: 2 };
}

function generateSignature(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// ============== Binance API ==============

function getBinanceBaseUrl(isTestnet?: boolean): string {
  return isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';
}

// ============== 统一接口实现 ==============

/**
 * 获取持仓
 */
export async function getPositions(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  symbol: string
): Promise<{ success: boolean; positions?: Position[]; error?: string }> {
  if (exchange === 'aster') {
    const result = await asterApi.getPositions({ apiKey: config.apiKey, apiSecret: config.apiSecret }, symbol);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      positions: result.positions?.map(p => ({
        symbol: p.symbol,
        positionSide: p.positionSide,
        positionAmt: p.positionAmt,
        entryPrice: p.entryPrice,
        notional: Math.abs(p.positionAmt * p.markPrice),
        leverage: p.leverage,
      })),
    };
  }

  // Binance
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(
      `${baseUrl}/fapi/v2/positionRisk?${queryString}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': config.apiKey } }
    );

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json() as Array<{
      symbol: string;
      positionSide: string;
      positionAmt: string;
      entryPrice: string;
      notional: string;
      leverage: string;
    }>;

    return {
      success: true,
      positions: data
        .filter(p => p.symbol === symbol)
        .map(p => ({
          symbol: p.symbol,
          positionSide: p.positionSide as 'LONG' | 'SHORT' | 'BOTH',
          positionAmt: parseFloat(p.positionAmt),
          entryPrice: parseFloat(p.entryPrice),
          notional: Math.abs(parseFloat(p.notional)),
          leverage: parseInt(p.leverage),
        })),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}

/**
 * 获取合约账户余额 (USDT/USDC)
 * 返回可用于下单的总保证金金额
 */
export async function getFuturesBalance(
  exchange: ExchangeType,
  config: ExchangeApiConfig
): Promise<{ success: boolean; balance?: number; error?: string }> {
  if (exchange === 'aster') {
    // Aster: 通过持仓接口估算，或使用特定接口
    // 暂时返回一个保守估计值，或者可以通过其他方式获取
    console.warn('[ExchangeAdapter] Aster 余额获取暂未实现，使用默认值');
    return { success: true, balance: 1000 }; // 默认 1000U
  }

  // Binance
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  console.log(`[ExchangeAdapter] 获取余额: baseUrl=${baseUrl}, isTestnet=${config.isTestnet}`);
  console.log(`[ExchangeAdapter] API Key: ${config.apiKey.substring(0, 8)}...`);

  try {
    const response = await fetch(
      `${baseUrl}/fapi/v2/account?${queryString}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': config.apiKey } }
    );

    if (!response.ok) {
      const errorData = await response.json() as { msg?: string };
      console.error(`[ExchangeAdapter] 获取余额失败: ${errorData.msg || `HTTP ${response.status}`}`);
      return { success: false, error: errorData.msg || `HTTP ${response.status}` };
    }

    const data = await response.json() as {
      totalWalletBalance: string;
      availableBalance: string;
      totalMarginBalance: string;
      assets?: Array<{
        asset: string;
        walletBalance: string;
        availableBalance: string;
      }>;
    };

    console.log(`[ExchangeAdapter] 账户数据返回:`, JSON.stringify({
      totalWalletBalance: data.totalWalletBalance,
      availableBalance: data.availableBalance,
      totalMarginBalance: data.totalMarginBalance,
      assetsCount: data.assets?.length || 0,
    }));
    
    if (data.assets && data.assets.length > 0) {
      console.log(`[ExchangeAdapter] 资产列表:`, data.assets.map(a => `${a.asset}:wallet=${a.walletBalance},available=${a.availableBalance}`).join('; '));
    } else {
      console.log(`[ExchangeAdapter] 警告: 资产列表为空`);
    }

    // 使用可用余额（优先有余额的 USDT 或 USDC）
    let balance = 0;
    const usdtAsset = data.assets?.find(a => a.asset === 'USDT');
    const usdcAsset = data.assets?.find(a => a.asset === 'USDC');
    
    const usdtBalance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;
    const usdcBalance = usdcAsset ? parseFloat(usdcAsset.availableBalance) : 0;
    
    if (usdtBalance > 0) {
      balance = usdtBalance;
      console.log(`[ExchangeAdapter] 使用 USDT 余额: ${balance.toFixed(2)}`);
    } else if (usdcBalance > 0) {
      balance = usdcBalance;
      console.log(`[ExchangeAdapter] 使用 USDC 余额: ${balance.toFixed(2)}`);
    } else {
      // 如果 USDT/USDC 都没有余额，使用总的 availableBalance
      balance = parseFloat(data.availableBalance);
      console.log(`[ExchangeAdapter] USDT/USDC 余额为0，使用总可用余额: ${balance.toFixed(2)}`);
    }

    console.log(`[ExchangeAdapter] 最终余额: ${balance.toFixed(2)} USDT/USDC`);
    return { success: true, balance };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}

/**
 * 获取挂单
 */
export async function getOpenOrders(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  symbol: string
): Promise<{ success: boolean; orders?: OpenOrder[]; error?: string }> {
  if (exchange === 'aster') {
    const result = await asterApi.getOpenOrders({ apiKey: config.apiKey, apiSecret: config.apiSecret }, symbol);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      orders: result.orders?.map(o => ({
        orderId: o.orderId,
        symbol: o.symbol,
        clientOrderId: o.clientOrderId,
        side: o.side,
        positionSide: o.positionSide,
        price: o.price,
        origQty: o.origQty.toString(),
        type: o.type,
        status: o.status,
      })),
    };
  }

  // Binance
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(
      `${baseUrl}/fapi/v1/openOrders?${queryString}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': config.apiKey } }
    );

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json() as Array<{
      orderId: number;
      symbol: string;
      clientOrderId: string;
      side: string;
      positionSide: string;
      price: string;
      origQty: string;
      type: string;
      status: string;
    }>;

    return {
      success: true,
      orders: data.map(o => ({
        orderId: o.orderId,
        symbol: o.symbol,
        clientOrderId: o.clientOrderId,
        side: o.side as 'BUY' | 'SELL',
        positionSide: o.positionSide as 'LONG' | 'SHORT' | 'BOTH',
        price: parseFloat(o.price),
        origQty: o.origQty,
        type: o.type,
        status: o.status,
      })),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}

/**
 * 设置杠杆
 */
export async function setLeverage(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  symbol: string,
  leverage: number
): Promise<{ success: boolean; error?: string }> {
  if (exchange === 'aster') {
    return asterApi.setLeverage({ apiKey: config.apiKey, apiSecret: config.apiSecret }, symbol, leverage);
  }

  // Binance
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/leverage`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    if (!response.ok) {
      const data = await response.json() as { msg?: string };
      return { success: false, error: data.msg || `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}

/**
 * 下限价单
 */
export async function placeLimitOrder(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    price: number;
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  const precision = getPrecision(params.symbol);

  if (exchange === 'aster') {
    return asterApi.placeOrder(
      { apiKey: config.apiKey, apiSecret: config.apiSecret },
      {
        symbol: params.symbol,
        side: params.side,
        positionSide: params.positionSide,
        type: 'LIMIT',
        quantity: params.quantity,
        price: params.price,
        clientOrderId: params.clientOrderId,
      }
    );
  }

  // Binance
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();

  const queryParams: Record<string, string | number> = {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: 'LIMIT',
    quantity: params.quantity.toFixed(precision.quantity),
    price: params.price.toFixed(precision.price),
    timeInForce: 'GTC',
    timestamp,
  };

  if (params.clientOrderId) {
    queryParams.newClientOrderId = params.clientOrderId;
  }

  const queryString = Object.entries(queryParams)
    .map(([k, v]) => `${k}=${v}`)
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

    const data = await response.json() as { orderId?: number; clientOrderId?: string; msg?: string };

    if (!response.ok) {
      return { success: false, error: data.msg || `HTTP ${response.status}` };
    }

    return {
      success: true,
      orderId: data.orderId,
      clientOrderId: data.clientOrderId,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}

/**
 * 下止损单 (STOP_MARKET)
 * 注意：Binance 使用 Algo Order API，Aster 使用普通订单 API
 */
export async function placeStopLossOrder(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    stopPrice: number;
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  const precision = getPrecision(params.symbol);

  if (exchange === 'aster') {
    // Aster 使用标准的 STOP_MARKET 订单
    return asterApi.placeStopLossOrder(
      { apiKey: config.apiKey, apiSecret: config.apiSecret },
      {
        symbol: params.symbol,
        side: params.side,
        positionSide: params.positionSide,
        quantity: params.quantity,
        stopPrice: params.stopPrice,
        clientOrderId: params.clientOrderId,
      }
    );
  }

  // Binance 使用 Algo Order API
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();

  const queryParams: Record<string, string | number> = {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    algoType: 'CONDITIONAL',
    type: 'STOP_MARKET',
    quantity: params.quantity.toFixed(precision.quantity),
    triggerPrice: params.stopPrice.toFixed(precision.price),
    workingType: 'MARK_PRICE',
    timestamp,
  };

  if (params.clientOrderId) {
    queryParams.clientAlgoId = params.clientOrderId;
  }

  const queryString = Object.entries(queryParams)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/algoOrder`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    const data = await response.json() as { algoId?: number; clientAlgoId?: string; msg?: string };

    if (!response.ok) {
      return { success: false, error: data.msg || `HTTP ${response.status}` };
    }

    return {
      success: true,
      orderId: data.algoId,
      clientOrderId: data.clientAlgoId,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}

/**
 * 下止盈限价单
 */
export async function placeTakeProfitOrder(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    price: number;
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  if (exchange === 'aster') {
    return asterApi.placeTakeProfitOrder(
      { apiKey: config.apiKey, apiSecret: config.apiSecret },
      {
        symbol: params.symbol,
        side: params.side,
        positionSide: params.positionSide,
        quantity: params.quantity,
        takeProfitPrice: params.price,
        clientOrderId: params.clientOrderId,
      }
    );
  }

  // Binance: 使用普通限价单作为止盈
  return placeLimitOrder(exchange, config, {
    ...params,
  });
}

/**
 * 取消订单
 */
export async function cancelOrder(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  symbol: string,
  orderId: number
): Promise<{ success: boolean; error?: string }> {
  if (exchange === 'aster') {
    return asterApi.cancelOrder({ apiKey: config.apiKey, apiSecret: config.apiSecret }, symbol, orderId);
  }

  // Binance
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/order`, {
      method: 'DELETE',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    if (!response.ok) {
      const data = await response.json() as { msg?: string };
      return { success: false, error: data.msg || `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}

/**
 * 取消所有带特定前缀的订单（包括普通订单和 Algo 订单）
 */
export async function cancelOrdersByPrefix(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  symbol: string,
  prefix: string
): Promise<{ success: boolean; canceledCount: number; error?: string }> {
  let canceledCount = 0;

  // 1. 取消普通订单
  const ordersResult = await getOpenOrders(exchange, config, symbol);
  if (ordersResult.success && ordersResult.orders) {
    const ordersToCancel = ordersResult.orders.filter(o => o.clientOrderId?.startsWith(prefix));
    for (const order of ordersToCancel) {
      const result = await cancelOrder(exchange, config, symbol, order.orderId);
      if (result.success) {
        canceledCount++;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  // 2. 取消 Algo 订单（止损、止盈等条件单）
  const algoOrdersResult = await getOpenAlgoOrders(exchange, config, symbol);
  if (algoOrdersResult.success && algoOrdersResult.orders) {
    const algoOrdersToCancel = algoOrdersResult.orders.filter(o => o.clientAlgoId?.startsWith(prefix));
    for (const order of algoOrdersToCancel) {
      const result = await cancelAlgoOrder(exchange, config, symbol, order.algoId);
      if (result.success) {
        canceledCount++;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (algoOrdersToCancel.length > 0) {
      console.log(`[cancelOrdersByPrefix] 取消了 ${algoOrdersToCancel.length} 个 Algo 订单`);
    }
  }

  return { success: true, canceledCount };
}

/**
 * 下追踪止盈单
 */
export async function placeTrailingStopOrder(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
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
  const precision = getPrecision(params.symbol);

  if (exchange === 'aster') {
    return asterApi.placeTrailingStopOrder(
      { apiKey: config.apiKey, apiSecret: config.apiSecret },
      {
        symbol: params.symbol,
        side: params.side,
        positionSide: params.positionSide,
        quantity: params.quantity,
        callbackRate: params.callbackRate,
        activationPrice: params.activationPrice,
        clientOrderId: params.clientOrderId,
      }
    );
  }

  // Binance: 使用 Algo Order API
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();

  const queryParams: Record<string, string | number> = {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    algoType: 'CONDITIONAL',
    type: 'TRAILING_STOP_MARKET',
    quantity: params.quantity.toFixed(precision.quantity),
    callbackRate: params.callbackRate,
    workingType: 'MARK_PRICE',
    timestamp,
  };

  if (params.activationPrice) {
    queryParams.activationPrice = params.activationPrice.toFixed(precision.price);
  }

  if (params.clientOrderId) {
    queryParams.clientAlgoId = params.clientOrderId;
  }

  const queryString = Object.entries(queryParams)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/algoOrder`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    const data = await response.json() as { algoId?: number; clientAlgoId?: string; msg?: string };

    if (!response.ok) {
      return { success: false, error: data.msg || `HTTP ${response.status}` };
    }

    return {
      success: true,
      orderId: data.algoId,
      clientOrderId: data.clientAlgoId,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}

/**
 * 获取 Algo 挂单列表 (Binance)
 */
export async function getOpenAlgoOrders(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  symbol: string
): Promise<{ success: boolean; orders?: Array<{ algoId: number; clientAlgoId: string; type: string }>; error?: string }> {
  if (exchange === 'aster') {
    // Aster 没有单独的 Algo 订单 API
    return { success: true, orders: [] };
  }

  // Binance
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(
      `${baseUrl}/fapi/v1/openAlgoOrders?${queryString}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': config.apiKey } }
    );

    if (!response.ok) {
      console.warn('[getOpenAlgoOrders] 获取 Algo 订单警告');
      return { success: true, orders: [] };
    }

    const data = await response.json() as { orders?: Array<{ algoId: number; clientAlgoId: string; type: string }> } | Array<{ algoId: number; clientAlgoId: string; type: string }>;

    const orders = Array.isArray(data) ? data : (data.orders || []);
    return { success: true, orders };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}

/**
 * 取消 Algo 订单 (Binance 专用)
 */
export async function cancelAlgoOrder(
  exchange: ExchangeType,
  config: ExchangeApiConfig,
  symbol: string,
  algoId: number
): Promise<{ success: boolean; error?: string }> {
  if (exchange === 'aster') {
    // Aster 使用普通取消订单
    return asterApi.cancelOrder({ apiKey: config.apiKey, apiSecret: config.apiSecret }, symbol, algoId);
  }

  // Binance: 使用 Algo Order API 取消
  const baseUrl = getBinanceBaseUrl(config.isTestnet);
  const timestamp = Date.now();
  const queryString = `algoId=${algoId}&timestamp=${timestamp}`;
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/algoOrder`, {
      method: 'DELETE',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    if (!response.ok) {
      const data = await response.json() as { msg?: string };
      return { success: false, error: data.msg || `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '网络错误' };
  }
}
