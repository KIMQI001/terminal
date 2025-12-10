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
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET';
  quantity: number;
  price?: number;           // 限价单价格
  stopPrice?: number;       // 触发价格 (仅 STOP/TAKE_PROFIT)
  callbackRate?: number;    // 追踪止盈回调比例 (0.1-10, 代表 0.1%-10%)
  activationPrice?: number; // 追踪止盈激活价格
  clientOrderId?: string;
  reduceOnly?: boolean;     // 是否只减仓
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

  // 追踪止盈单参数
  if (params.type === 'TRAILING_STOP_MARKET') {
    if (params.callbackRate) {
      queryParams.callbackRate = params.callbackRate;
    }
    if (params.activationPrice) {
      queryParams.activationPrice = formatPrice(params.activationPrice, precision.price);
    }
  }

  // 自定义订单 ID
  if (params.clientOrderId) {
    queryParams.newClientOrderId = params.clientOrderId;
  }

  // 只减仓标志（双向持仓模式下使用 positionSide 时不能用 reduceOnly）
  if (params.reduceOnly && !params.positionSide) {
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
 * 下条件订单到 Binance Futures Algo Service
 * 用于 STOP_MARKET, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET 等条件订单
 *
 * 从 2025-12-09 开始，这些订单类型必须使用此 API
 */
export async function placeAlgoOrder(
  config: BinanceApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET';
    quantity: number;
    triggerPrice?: number;        // 触发价格 (STOP_MARKET/TAKE_PROFIT_MARKET)
    callbackRate?: number;        // 追踪止盈回调比例 (0.1-10, 代表 0.1%-10%)
    activationPrice?: number;     // 追踪止盈激活价格
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  const baseUrl = config.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const precision = getPrecision(params.symbol);

  // 构建请求参数
  const queryParams: Record<string, string | number> = {
    algoType: 'CONDITIONAL',
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: params.type,
    quantity: formatQuantity(params.quantity, precision.quantity),
    timestamp,
  };

  // 止盈止损单需要触发价格
  if ((params.type === 'STOP_MARKET' || params.type === 'TAKE_PROFIT_MARKET') && params.triggerPrice) {
    queryParams.triggerPrice = formatPrice(params.triggerPrice, precision.price);
  }

  // 追踪止盈单参数
  if (params.type === 'TRAILING_STOP_MARKET') {
    if (params.callbackRate) {
      queryParams.callbackRate = params.callbackRate;
    }
    if (params.activationPrice) {
      queryParams.activationPrice = formatPrice(params.activationPrice, precision.price);
    }
  }

  // 自定义订单 ID
  if (params.clientOrderId) {
    queryParams.clientAlgoId = params.clientOrderId;
  }

  // 注意：Algo Order API 不支持 reduceOnly 参数，条件单会自动减仓

  // 生成签名
  const queryString = Object.entries(queryParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signature = generateSignature(queryString, config.apiSecret);

  // 调试日志：打印实际请求参数
  console.log(`[AlgoOrder] 请求参数:`, JSON.stringify(queryParams, null, 2));

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/algoOrder`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    const data = await response.json() as { msg?: string; algoId?: number; clientAlgoId?: string; success?: boolean; activatePrice?: string; callbackRate?: string };

    // 调试日志：打印 Binance 返回的响应
    console.log(`[AlgoOrder] 响应数据:`, JSON.stringify(data, null, 2));

    if (!response.ok) {
      return {
        success: false,
        error: data.msg || `HTTP ${response.status}`,
      };
    }

    return {
      success: true,
      orderId: data.algoId,
      clientOrderId: data.clientAlgoId,
      status: 'NEW',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络请求失败',
    };
  }
}

/**
 * 下止损条件单 (STOP_MARKET)
 * 从 2025-12-09 开始必须使用 Algo Order API
 */
export async function placeStopLossOrder(
  config: BinanceApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';       // 平仓方向
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    stopPrice: number;          // 止损触发价格
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  return placeAlgoOrder(config, {
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: 'STOP_MARKET',
    quantity: params.quantity,
    triggerPrice: params.stopPrice,
    clientOrderId: params.clientOrderId,
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

/**
 * 市价平仓
 * 用于追踪止盈触发时快速平仓
 */
export async function closePositionMarket(
  config: BinanceApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';       // 平仓方向 (多单平仓用SELL，空单平仓用BUY)
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
 * 根据 clientOrderId 取消订单
 */
export async function cancelOrderByClientId(
  config: BinanceApiConfig,
  symbol: string,
  clientOrderId: string
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = config.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&origClientOrderId=${clientOrderId}&timestamp=${timestamp}`;
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
 * 下追踪止盈单 (TRAILING_STOP_MARKET)
 *
 * 注意：从 2025-12-09 开始，Binance 将条件订单迁移到 Algo Service
 * 必须使用 /fapi/v1/algoOrder 端点
 *
 * 原理：
 * - 设置 activationPrice 作为激活价格（达到此价后开始追踪）
 * - 设置 callbackRate 作为回撤比例（从最高/低价回撤此比例后触发）
 *
 * 例如做多：
 * - activationPrice = 入场价 * 1.015 (盈利1.5%后激活)
 * - callbackRate = 0.3 (从最高价回撤0.3%后触发卖出)
 */
export async function placeTrailingStopOrder(
  config: BinanceApiConfig,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';         // 平仓方向 (多单平仓用SELL，空单平仓用BUY)
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    callbackRate: number;          // 回撤比例 0.1-10 (代表 0.1%-10%)
    activationPrice?: number;      // 激活价格（可选，不设则立即激活）
    clientOrderId?: string;
  }
): Promise<OrderResult> {
  return placeAlgoOrder(config, {
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
 * 仓位信息接口
 */
export interface PositionInfo {
  symbol: string;
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  positionAmt: number;       // 持仓数量 (正数做多，负数做空)
  entryPrice: number;        // 入场均价
  markPrice: number;         // 标记价格
  unRealizedProfit: number;  // 未实现盈亏
  liquidationPrice: number;  // 强平价格
  leverage: number;          // 杠杆倍数
  marginType: string;        // 保证金类型
  isolatedMargin: number;    // 逐仓保证金
}

/**
 * 获取所有持仓
 */
export async function getPositions(
  config: BinanceApiConfig,
  symbol?: string
): Promise<{ success: boolean; positions?: PositionInfo[]; error?: string }> {
  const baseUrl = config.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  let queryString = `timestamp=${timestamp}`;
  if (symbol) {
    queryString = `symbol=${symbol}&${queryString}`;
  }
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v2/positionRisk?${queryString}&signature=${signature}`, {
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

    // 过滤出有实际持仓的仓位
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
  type: string;            // LIMIT, STOP_MARKET, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  stopPrice: number;       // 触发价 (止盈止损单)
  workingType: string;     // 触发类型
  time: number;
}

/**
 * 获取当前挂单（包括普通订单和 Algo 条件单）
 */
export async function getOpenOrders(
  config: BinanceApiConfig,
  symbol?: string
): Promise<{ success: boolean; orders?: OpenOrderInfo[]; error?: string }> {
  const baseUrl = config.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  let queryString = `timestamp=${timestamp}`;
  if (symbol) {
    queryString = `symbol=${symbol}&${queryString}`;
  }
  const signature = generateSignature(queryString, config.apiSecret);

  try {
    // 并行获取普通订单和 Algo 条件单
    const [normalResponse, algoResponse] = await Promise.all([
      // 普通订单
      fetch(`${baseUrl}/fapi/v1/openOrders?${queryString}&signature=${signature}`, {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': config.apiKey },
      }),
      // Algo 条件单（需要重新生成签名，因为时间戳可能不同）
      (async () => {
        const algoTimestamp = Date.now();
        let algoQueryString = `timestamp=${algoTimestamp}`;
        if (symbol) {
          algoQueryString = `symbol=${symbol}&${algoQueryString}`;
        }
        const algoSignature = generateSignature(algoQueryString, config.apiSecret);
        return fetch(`${baseUrl}/fapi/v1/openAlgoOrders?${algoQueryString}&signature=${algoSignature}`, {
          method: 'GET',
          headers: { 'X-MBX-APIKEY': config.apiKey },
        });
      })(),
    ]);

    const normalData = await normalResponse.json() as Array<{
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

    if (!normalResponse.ok) {
      return {
        success: false,
        error: (normalData as { msg?: string }).msg || `HTTP ${normalResponse.status}`,
      };
    }

    // 格式化普通订单
    const normalOrders = (normalData as Array<{
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

    // 处理 Algo 订单
    let algoOrders: OpenOrderInfo[] = [];
    if (algoResponse.ok) {
      const algoData = await algoResponse.json() as Array<{
        algoId: number;
        symbol: string;
        clientAlgoId: string;
        quantity: string;
        side: string;
        positionSide: string;
        orderType: string;
        triggerPrice?: string;
        activationPrice?: string;
        algoStatus: string;
        createTime: number;
      }>;

      if (Array.isArray(algoData)) {
        algoOrders = algoData.map(o => ({
          orderId: o.algoId,
          symbol: o.symbol,
          clientOrderId: o.clientAlgoId || '',
          price: 0,
          origQty: parseFloat(o.quantity),
          executedQty: 0,
          status: o.algoStatus,
          type: o.orderType || 'STOP_MARKET',
          side: o.side as 'BUY' | 'SELL',
          positionSide: o.positionSide as 'LONG' | 'SHORT' | 'BOTH',
          stopPrice: parseFloat(o.triggerPrice || '0') || parseFloat(o.activationPrice || '0'),
          workingType: 'CONTRACT_PRICE',
          time: o.createTime,
        }));
      }
    }

    // 合并两种订单
    const allOrders = [...normalOrders, ...algoOrders];

    return { success: true, orders: allOrders };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络请求失败',
    };
  }
}
