/**
 * 订单监控主模块
 * 监听入场单成交，自动下止盈止损平仓限价单
 */

import { UserDataStreamManager, OrderTradeUpdateEvent } from './userDataStream';
import { AsterUserDataStreamManager } from './asterUserDataStream';
import {
  getPendingOrderByClientId,
  markOrderFilled,
  markSlTpPlaced,
  markOrderCanceled,
  markOrderError,
  markOrderClosedWithPnL,
  initPendingOrdersTable,
  cleanupOldPendingOrders,
  cleanupCanceledOrders,
  getOrderStats,
  PendingEntryOrder,
  ExchangeType,
} from './pendingOrderStore';
import {
  placeStopLossOrder,
  placeTakeProfitOrder,
  placeTrailingStopOrder,
  getOpenOrders,
  getPositions,
  cancelOrder,
  cancelAlgoOrder,
  BinanceApiConfig,
} from './binanceOrderApi';
import * as exchangeAdapter from './exchangeAdapter';
import { sendDingtalkMarkdownToUser } from '../notification/dingtalk';
import { isPositionMonitorEnabled } from './apiConfigReader';

// 订单监控器配置
export interface OrderMonitorConfig {
  userId: number;
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
  // Aster 配置（可选）
  asterApiKey?: string;
  asterApiSecret?: string;
}

let streamManager: UserDataStreamManager | null = null;
let asterStreamManager: AsterUserDataStreamManager | null = null;
let config: OrderMonitorConfig | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;

// 普通订单入场信息存储（用于仓位监控）
// key: original clientOrderId, value: entry info
const normalOrderEntries = new Map<string, {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  stopLossPrice: number;
  stopLossOrderId: string | null;
  entryTime: number;
}>();

/**
 * 获取指定交易所的 API 配置
 */
function getExchangeConfig(exchange: ExchangeType): exchangeAdapter.ExchangeApiConfig | null {
  if (!config) return null;

  if (exchange === 'aster') {
    if (!config.asterApiKey || !config.asterApiSecret) {
      return null;
    }
    return {
      apiKey: config.asterApiKey,
      apiSecret: config.asterApiSecret,
      isTestnet: false,
    };
  }

  // Binance
  return {
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    isTestnet: config.isTestnet,
  };
}

/**
 * 处理订单成交事件
 * 只处理数据库中存在的待处理订单（通过 clientOrderId 匹配）
 * 也处理普通订单（非守塔、非流动性网格）当仓位监控开启时
 */
async function handleOrderFilled(event: OrderTradeUpdateEvent): Promise<void> {
  const { order } = event;
  const clientOrderId = order.clientOrderId;
  const symbol = order.symbol;

  // 快速过滤：只处理 ict_tower 或 liq_grid 前缀的订单
  const isTowerOrder = clientOrderId.startsWith('ict_tower');
  const isLiqGridOrder = clientOrderId.startsWith('liq_grid');

  // 处理止盈止损单成交（记录战绩）- 所有订单类型都可能触发
  if (order.orderStatus === 'FILLED') {
    if (clientOrderId.includes('_sl_') || clientOrderId.includes('_sl')) {
      console.log(`[OrderMonitor] ${symbol} 止损单成交: ${clientOrderId} @ ${order.averagePrice}`);
      await handleSlTpFilled(clientOrderId, order, 'sl');
      return;
    }
    if (clientOrderId.includes('_tp_') || clientOrderId.includes('_tp')) {
      console.log(`[OrderMonitor] ${symbol} 止盈单成交: ${clientOrderId} @ ${order.averagePrice}`);
      await handleSlTpFilled(clientOrderId, order, 'tp');
      return;
    }
    if (clientOrderId.includes('_trail') || clientOrderId.includes('_tr')) {
      console.log(`[OrderMonitor] ${symbol} 追踪止盈单成交: ${clientOrderId} @ ${order.averagePrice}`);
      await handleSlTpFilled(clientOrderId, order, 'trailing');
      return;
    }
  }

  // 如果是守塔或流动性网格订单，需要检查数据库中的待处理订单
  if (isTowerOrder || isLiqGridOrder) {
    // 核心验证：只处理数据库中存在的待处理订单
    const pendingOrder = getPendingOrderByClientId(clientOrderId);
    if (!pendingOrder) {
      // 不在我们的待处理订单列表中，忽略
      return;
    }

    // 验证交易对是否匹配
    if (pendingOrder.symbol !== symbol) {
      console.warn(`[OrderMonitor] 交易对不匹配: 期望 ${pendingOrder.symbol}, 实际 ${symbol}`);
      return;
    }

    // 处理入场单状态变化
    if (order.orderStatus === 'FILLED') {
      console.log(`[OrderMonitor] ${symbol} 入场单成交: ${clientOrderId} @ ${order.averagePrice}`);

      // 根据订单类型选择不同的处理逻辑
      if (isLiqGridOrder) {
        await handleLiqGridEntryFilled(clientOrderId, order, pendingOrder);
      } else {
        await handleEntryFilled(clientOrderId, order, pendingOrder);
      }
    } else if (order.orderStatus === 'CANCELED') {
      console.log(`[OrderMonitor] ${symbol} 入场单取消: ${clientOrderId}`);
      await handleEntryCanceled(clientOrderId);
    }
    return;
  }

  // 普通订单（非守塔、非流动性网格）- 检查是否开启仓位监控
  if (config && isPositionMonitorEnabled(config.userId)) {
    // 处理普通订单的成交
    await handleNormalOrderFilled(event);
  }
}

/**
 * 处理入场单成交
 */
async function handleEntryFilled(
  clientOrderId: string,
  order: OrderTradeUpdateEvent['order'],
  pendingOrder: PendingEntryOrder
): Promise<void> {
  const filledPrice = parseFloat(order.averagePrice);

  // 更新状态为已成交
  markOrderFilled(clientOrderId, filledPrice);

  if (!config) {
    console.error('[OrderMonitor] 配置未初始化');
    markOrderError(clientOrderId, '配置未初始化');
    return;
  }

  const apiConfig: BinanceApiConfig = {
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    isTestnet: config.isTestnet,
  };

  // 平仓方向 (与入场方向相反)
  const closeSide = pendingOrder.side === 'BUY' ? 'SELL' : 'BUY';

  let slOrderId: string | null = null;
  let tpOrderId: string | null = null;
  const errors: string[] = [];

  try {
    // 先检查是否已有当前入场单的止盈止损单（通过 clientOrderId 前缀匹配）
    const existingOrdersResult = await getOpenOrders(apiConfig, pendingOrder.symbol);
    const existingOrders = existingOrdersResult.success ? (existingOrdersResult.orders || []) : [];

    // 只检查属于当前入场单的止盈止损（通过 clientOrderId 前缀匹配）
    const orderPrefix = clientOrderId + '_';
    const myOrders = existingOrders.filter(o => o.clientOrderId?.startsWith(orderPrefix));

    // 检查是否已有止损单（属于当前入场单）
    const hasStopLoss = myOrders.some(o => o.type === 'STOP_MARKET');

    // 检查是否已有止盈单（属于当前入场单）
    const hasTakeProfit = myOrders.some(o => o.type === 'LIMIT' || o.type === 'TAKE_PROFIT_MARKET');

    // 检查是否已有追踪止盈（属于当前入场单）
    const hasTrailingStop = myOrders.some(o => o.type === 'TRAILING_STOP_MARKET');

    console.log(`[OrderMonitor] 检查现有订单(${clientOrderId}): 止损=${hasStopLoss}, 止盈=${hasTakeProfit}, 追踪=${hasTrailingStop}, 匹配订单数=${myOrders.length}`);

    // 只下缺失的单
    if (!hasStopLoss) {
      // 下止损单，使用短后缀避免超过36字符限制
      const shortSuffix = Math.random().toString(36).slice(-4);
      const slClientId = `${clientOrderId}_sl${shortSuffix}`;
      console.log(`[OrderMonitor] 下止损单: ${pendingOrder.stopLoss}`);
      const slResult = await placeStopLossOrder(apiConfig, {
        symbol: pendingOrder.symbol,
        side: closeSide,
        positionSide: pendingOrder.positionSide,
        quantity: pendingOrder.quantity,
        stopPrice: pendingOrder.stopLoss,
        clientOrderId: slClientId,
      });

      if (slResult.success) {
        slOrderId = slResult.orderId?.toString() || null;
        console.log(`[OrderMonitor] 止损单下单成功: ${slClientId}`);
      } else {
        errors.push(`止损单失败: ${slResult.error}`);
        console.error(`[OrderMonitor] 止损单失败: ${slResult.error}`);
      }
    } else {
      console.log(`[OrderMonitor] 止损单已存在，跳过`);
      slOrderId = 'exists';
    }

    if (!hasTakeProfit) {
      // 下固定止盈单，使用短后缀避免超过36字符限制
      const tpSuffix = Math.random().toString(36).slice(-4);
      const tpClientId = `${clientOrderId}_tp${tpSuffix}`;
      console.log(`[OrderMonitor] 下固定止盈单: ${pendingOrder.takeProfit}`);
      const fixedTpResult = await placeTakeProfitOrder(apiConfig, {
        symbol: pendingOrder.symbol,
        side: closeSide,
        positionSide: pendingOrder.positionSide,
        quantity: pendingOrder.quantity,
        takeProfitPrice: pendingOrder.takeProfit,
        clientOrderId: tpClientId,
      });

      if (fixedTpResult.success) {
        tpOrderId = fixedTpResult.orderId?.toString() || null;
        console.log(`[OrderMonitor] 固定止盈单下单成功: ${tpClientId}`);
      } else {
        errors.push(`固定止盈单失败: ${fixedTpResult.error}`);
        console.error(`[OrderMonitor] 固定止盈单失败: ${fixedTpResult.error}`);
      }
    } else {
      console.log(`[OrderMonitor] 止盈单已存在，跳过`);
      tpOrderId = 'exists';
    }

    // 下追踪止盈单（如果还没有）
    if (!hasTrailingStop) {
      // 使用订单配置的追踪止盈参数
      const activationRatio = pendingOrder.trailingActivationRatio; // 默认 0.02 = 2%
      const callbackRate = pendingOrder.trailingCallbackRate;       // 默认 0.3 = 0.3%

      const trailingActivationPrice = pendingOrder.positionSide === 'LONG'
        ? filledPrice * (1 + activationRatio)   // 多单：价格上涨后激活
        : filledPrice * (1 - activationRatio);  // 空单：价格下跌后激活

      const trailSuffix = Math.random().toString(36).slice(-4);
      const trailClientId = `${clientOrderId}_tr${trailSuffix}`;
      console.log(`[OrderMonitor] 下追踪止盈单: 激活价=${trailingActivationPrice.toFixed(2)}, 激活比例=${(activationRatio * 100).toFixed(2)}%, 回撤=${callbackRate}%`);
      const trailingTpResult = await placeTrailingStopOrder(apiConfig, {
        symbol: pendingOrder.symbol,
        side: closeSide,
        positionSide: pendingOrder.positionSide,
        quantity: pendingOrder.quantity,
        callbackRate: callbackRate,
        activationPrice: trailingActivationPrice,
        clientOrderId: trailClientId,
      });

      if (trailingTpResult.success) {
        console.log(`[OrderMonitor] 追踪止盈单下单成功: ${trailClientId}`);
      } else {
        errors.push(`追踪止盈单失败: ${trailingTpResult.error}`);
        console.error(`[OrderMonitor] 追踪止盈单失败: ${trailingTpResult.error}`);
      }
    } else {
      console.log(`[OrderMonitor] 追踪止盈单已存在，跳过`);
    }

    // 更新数据库状态
    if (slOrderId || tpOrderId) {
      markSlTpPlaced(clientOrderId, slOrderId, tpOrderId);
    }

    if (errors.length > 0) {
      markOrderError(clientOrderId, errors.join('; '));
    }

    // 发送钉钉通知
    await sendEntryFilledNotification(pendingOrder, filledPrice, slOrderId, tpOrderId, errors);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[OrderMonitor] 下止盈止损单异常:`, error);
    markOrderError(clientOrderId, errorMsg);

    // 发送错误通知
    await sendDingtalkMarkdownToUser(
      config!.userId,
      '止盈止损下单失败',
      `### 止盈止损下单失败 ❌\n\n` +
      `- **订单**: ${clientOrderId}\n` +
      `- **交易对**: ${pendingOrder.symbol}\n` +
      `- **成交价**: $${filledPrice.toFixed(2)}\n` +
      `- **错误**: ${errorMsg}\n\n` +
      `**请手动下单止盈止损！**`
    );
  }
}

/**
 * 计算流动性网格止盈价（已知成本价）
 * 找对向订单中满足 2% 利润的第一个，否则使用固定 2%
 * @param entrySide 入场方向 (BUY/SELL)
 * @param costPrice 持仓成本价
 * @returns 止盈价
 */
async function calculateLiqGridTakeProfitWithCost(
  apiConfig: BinanceApiConfig,
  symbol: string,
  entrySide: string,
  costPrice: number
): Promise<number> {
  const minProfitRatio = 0.02;

  try {
    // 获取当前所有开放订单
    const openOrdersResult = await getOpenOrders(apiConfig, symbol);
    if (!openOrdersResult.success || !openOrdersResult.orders) {
      console.log('[LiqGrid] 获取开放订单失败，使用固定2%止盈');
      return entrySide === 'BUY' ? costPrice * 1.02 : costPrice * 0.98;
    }

    // 筛选 liq_grid 对向订单（限价入场单）
    const orders = openOrdersResult.orders.filter(o => {
      // 只要 liq_grid 开头的限价单
      if (!o.clientOrderId?.startsWith('liq_grid')) return false;
      if (o.type !== 'LIMIT') return false;
      // 对向订单：入场做多找空单，入场做空找多单
      if (entrySide === 'BUY') {
        return o.side === 'SELL'; // 找空单（在上方）
      } else {
        return o.side === 'BUY'; // 找多单（在下方）
      }
    });

    let minTpPrice: number;

    if (entrySide === 'BUY') {
      // 做多：止盈价 >= 持仓成本价 * 1.02
      minTpPrice = costPrice * (1 + minProfitRatio);
      // 找上方满足条件的第一个空单（价格最低的）
      const validOrders = orders
        .filter(o => o.price >= minTpPrice)
        .sort((a, b) => a.price - b.price);

      if (validOrders.length > 0) {
        console.log(`[LiqGrid] 多单止盈: 成本价=${costPrice.toFixed(2)}, 最低止盈=${minTpPrice.toFixed(2)}, 选中对向空单=${validOrders[0].price}`);
        return validOrders[0].price;
      }
    } else {
      // 做空：止盈价 <= 持仓成本价 * 0.98
      minTpPrice = costPrice * (1 - minProfitRatio);
      // 找下方满足条件的第一个多单（价格最高的）
      const validOrders = orders
        .filter(o => o.price <= minTpPrice)
        .sort((a, b) => b.price - a.price);

      if (validOrders.length > 0) {
        console.log(`[LiqGrid] 空单止盈: 成本价=${costPrice.toFixed(2)}, 最高止盈=${minTpPrice.toFixed(2)}, 选中对向多单=${validOrders[0].price}`);
        return validOrders[0].price;
      }
    }

    // 没有满足条件的对向订单，使用固定 2% 止盈
    console.log(`[LiqGrid] 没有满足2%利润的对向订单，使用固定2%止盈: ${minTpPrice.toFixed(2)}`);
    return minTpPrice;
  } catch (error) {
    console.error('[LiqGrid] 计算止盈价异常:', error);
    // 出错时也返回固定 2% 止盈
    const fallbackTpPrice = entrySide === 'BUY'
      ? costPrice * 1.02
      : costPrice * 0.98;
    return fallbackTpPrice;
  }
}

/**
 * 处理流动性网格订单入场成交
 * 一次性止盈整个持仓，每次入场后更新止盈单
 */
async function handleLiqGridEntryFilled(
  clientOrderId: string,
  order: OrderTradeUpdateEvent['order'],
  pendingOrder: PendingEntryOrder
): Promise<void> {
  const filledPrice = parseFloat(order.averagePrice);

  // 更新状态为已成交
  markOrderFilled(clientOrderId, filledPrice);

  if (!config) {
    console.error('[OrderMonitor] 配置未初始化');
    markOrderError(clientOrderId, '配置未初始化');
    return;
  }

  const apiConfig: BinanceApiConfig = {
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    isTestnet: config.isTestnet,
  };

  // 平仓方向 (与入场方向相反)
  const closeSide = pendingOrder.side === 'BUY' ? 'SELL' : 'BUY';
  const positionSide = pendingOrder.positionSide;

  let tpOrderId: string | null = null;
  const errors: string[] = [];

  try {
    // 1. 取消现有的 liq_grid 止盈单
    const existingOrders = await getOpenOrders(apiConfig, pendingOrder.symbol);
    if (existingOrders.success && existingOrders.orders) {
      const existingTpOrders = existingOrders.orders.filter(o =>
        o.clientOrderId?.startsWith('lg_') &&
        o.clientOrderId?.includes('_tp') &&
        o.positionSide === positionSide &&
        o.type === 'TAKE_PROFIT_MARKET'
      );
      for (const tpOrder of existingTpOrders) {
        console.log(`[LiqGrid] 取消旧止盈单: ${tpOrder.clientOrderId}`);
        await cancelAlgoOrder(apiConfig, pendingOrder.symbol, tpOrder.orderId);
      }
    }

    // 2. 获取当前整个持仓数量
    const positionsResult = await getPositions(apiConfig, pendingOrder.symbol);
    let positionQty = pendingOrder.quantity; // 默认用入场数量
    let costPrice = filledPrice;

    if (positionsResult.success && positionsResult.positions) {
      const position = positionsResult.positions.find(
        p => p.positionSide === positionSide && Math.abs(parseFloat(String(p.positionAmt))) >= 0.001
      );
      if (position) {
        positionQty = Math.abs(parseFloat(String(position.positionAmt)));
        costPrice = parseFloat(String(position.entryPrice));
        console.log(`[LiqGrid] 持仓: 数量=${positionQty}, 成本价=${costPrice}`);
      }
    }

    // 3. 计算止盈价：找对向订单中满足 2% 利润的第一个
    const takeProfitPrice = await calculateLiqGridTakeProfitWithCost(
      apiConfig,
      pendingOrder.symbol,
      pendingOrder.side,
      costPrice
    );

    if (takeProfitPrice > 0) {
      // 缩短 clientOrderId
      const side = pendingOrder.side === 'BUY' ? 'b' : 's';
      const ts = Date.now().toString().slice(-6);
      const tpClientId = `lg_${side}_tp${ts}`;
      console.log(`[LiqGrid] 下止盈单: 价格=${takeProfitPrice}, 数量=${positionQty}, clientId=${tpClientId}`);

      const tpResult = await placeTakeProfitOrder(apiConfig, {
        symbol: pendingOrder.symbol,
        side: closeSide,
        positionSide: positionSide,
        quantity: positionQty,
        takeProfitPrice: takeProfitPrice,
        clientOrderId: tpClientId,
      });

      if (tpResult.success) {
        tpOrderId = tpResult.orderId?.toString() || null;
        console.log(`[LiqGrid] 止盈单下单成功: ${tpClientId}, 止盈价=${takeProfitPrice}`);
      } else {
        errors.push(`止盈单失败: ${tpResult.error}`);
        console.error(`[LiqGrid] 止盈单失败: ${tpResult.error}`);
      }
    } else {
      console.log(`[LiqGrid] 未找到满足2%利润的对向订单，跳过止盈单`);
    }

    // 更新数据库状态（liq_grid 没有止损，所以 slOrderId 为 null）
    if (tpOrderId) {
      markSlTpPlaced(clientOrderId, null, tpOrderId);
    }

    if (errors.length > 0) {
      markOrderError(clientOrderId, errors.join('; '));
    }

    // 发送钉钉通知
    await sendLiqGridFilledNotification(pendingOrder, filledPrice, tpOrderId, errors);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[LiqGrid] 下止盈单异常:`, error);
    markOrderError(clientOrderId, errorMsg);

    // 发送错误通知
    await sendDingtalkMarkdownToUser(
      config!.userId,
      '流动性网格止盈下单失败',
      `### 流动性网格止盈下单失败 ❌\n\n` +
      `- **订单**: ${clientOrderId}\n` +
      `- **交易对**: ${pendingOrder.symbol}\n` +
      `- **成交价**: $${filledPrice.toFixed(2)}\n` +
      `- **错误**: ${errorMsg}\n\n` +
      `**请手动下单止盈！**`
    );
  }
}

/**
 * 发送流动性网格入场成交通知
 */
async function sendLiqGridFilledNotification(
  order: PendingEntryOrder,
  filledPrice: number,
  tpOrderId: string | null,
  errors: string[]
): Promise<void> {
  const direction = order.side === 'BUY' ? '做多' : '做空';
  const symbol = order.symbol.replace('USDC', '').replace('USDT', '');

  // 计算预期盈利点数
  const profitPoints = order.side === 'BUY'
    ? order.takeProfit - filledPrice
    : filledPrice - order.takeProfit;

  let statusIcon = '✅';
  let statusText = '止盈已挂单';

  if (errors.length > 0) {
    statusIcon = '⚠️';
    statusText = `止盈失败: ${errors.join(', ')}`;
  }

  if (!tpOrderId) {
    statusIcon = '❌';
    statusText = '止盈挂单失败，请手动处理';
  }

  const content = [
    `### ${statusIcon} 流动性网格成交`,
    '',
    `- **交易对**: ${symbol}`,
    `- **方向**: ${direction}`,
    `- **成交价**: $${filledPrice.toFixed(2)}`,
    `- **数量**: ${order.quantity.toFixed(3)}`,
    `- **止盈价**: $${order.takeProfit.toFixed(2)}`,
    `- **预期盈利**: ${profitPoints.toFixed(2)} 点`,
    '',
    `**状态**: ${statusText}`,
  ].join('\n');

  await sendDingtalkMarkdownToUser(config!.userId, `${symbol} 流动性网格${direction}成交`, content);
}

/**
 * 处理入场单取消
 */
async function handleEntryCanceled(clientOrderId: string): Promise<void> {
  console.log(`[OrderMonitor] 入场单已取消: ${clientOrderId}`);
  markOrderCanceled(clientOrderId);
}

/**
 * 处理普通订单（非守塔、非流动性网格）成交
 * 当用户开启仓位监控时，监听所有订单成交并自动下止损单
 */
async function handleNormalOrderFilled(event: OrderTradeUpdateEvent): Promise<void> {
  const { order } = event;
  const clientOrderId = order.clientOrderId;
  const symbol = order.symbol;

  // 只处理入场单成交（NEW -> FILLED）
  if (order.executionType !== 'NEW' || order.orderStatus !== 'FILLED') {
    return;
  }

  // 跳过已经处理过的订单（如果有 _sl, _tp, _tr 后缀）
  if (clientOrderId.includes('_sl') || clientOrderId.includes('_tp') || clientOrderId.includes('_tr')) {
    return;
  }

  // 跳过我们的止损单
  if (clientOrderId.includes('_normal_sl')) {
    return;
  }

  const filledPrice = parseFloat(order.averagePrice);
  const quantity = parseFloat(order.originalQuantity);
  const side = order.side;
  const positionSide = order.positionSide as 'LONG' | 'SHORT';

  console.log(`[OrderMonitor] 普通订单成交: ${clientOrderId} @ ${filledPrice} ${side} ${quantity} ${positionSide}`);

  if (!config) {
    console.error('[OrderMonitor] 配置未初始化');
    return;
  }

  const apiConfig: BinanceApiConfig = {
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    isTestnet: config.isTestnet,
  };

  // 平仓方向 (与入场方向相反)
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

  // 计算 2% 止损价
  const stopLossPrice = side === 'BUY'
    ? filledPrice * (1 - 0.02)  // 做多：2% 止损
    : filledPrice * (1 + 0.02); // 做空：2% 止损

  try {
    // 检查是否已有止损单
    const existingOrdersResult = await getOpenOrders(apiConfig, symbol);
    const existingOrders = existingOrdersResult.success ? (existingOrdersResult.orders || []) : [];

    // 查找是否已有属于这个订单的止损单
    const myOrders = existingOrders.filter(o => o.clientOrderId?.startsWith(clientOrderId + '_'));
    const hasStopLoss = myOrders.some(o => o.type === 'STOP_MARKET');

    let slOrderId: string | null = null;
    let slError: string | null = null;
    let slClientIdForStorage: string | null = null;

    if (!hasStopLoss) {
      // 下止损单
      const slSuffix = Math.random().toString(36).slice(-4);
      const slClientId = `${clientOrderId}_normal_sl${slSuffix}`;
      slClientIdForStorage = slClientId;
      console.log(`[OrderMonitor] 普通订单下止损单: ${slClientId} 止损价=${stopLossPrice}`);

      const slResult = await placeStopLossOrder(apiConfig, {
        symbol,
        side: closeSide,
        positionSide,
        quantity,
        stopPrice: stopLossPrice,
        clientOrderId: slClientId,
      });

      if (slResult.success) {
        slOrderId = slResult.orderId?.toString() || null;
        console.log(`[OrderMonitor] 止损单下单成功: ${slClientId}`);
      } else {
        slError = slResult.error || '下单失败';
        console.error(`[OrderMonitor] 止损单失败: ${slError}`);
      }
    } else {
      console.log(`[OrderMonitor] 止损单已存在，跳过`);
      slOrderId = 'exists';
    }

    // 存储入场信息，用于止损触发时计算盈亏
    normalOrderEntries.set(clientOrderId, {
      symbol,
      side,
      positionSide,
      entryPrice: filledPrice,
      quantity,
      stopLossPrice,
      stopLossOrderId: slClientIdForStorage,
      entryTime: Date.now(),
    });

    // 发送入场成交通知
    await sendNormalOrderFilledNotification(symbol, side, positionSide, filledPrice, quantity, stopLossPrice, slOrderId, slError);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[OrderMonitor] 普通订单处理异常:`, error);

    // 发送错误通知
    await sendDingtalkMarkdownToUser(
      config.userId,
      '普通订单止损下单失败',
      `### 普通订单止损下单失败 ❌\n\n` +
      `- **订单**: ${clientOrderId}\n` +
      `- **交易对**: ${symbol}\n` +
      `- **成交价**: $${filledPrice.toFixed(2)}\n` +
      `- **数量**: ${quantity}\n` +
      `- **方向**: ${side === 'BUY' ? '做多' : '做空'}\n` +
      `- **错误**: ${errorMsg}\n\n` +
      `**请手动下单止损！**`
    );
  }
}

/**
 * 发送普通订单入场成交通知
 */
async function sendNormalOrderFilledNotification(
  symbol: string,
  side: 'BUY' | 'SELL',
  positionSide: string,
  filledPrice: number,
  quantity: number,
  stopLossPrice: number,
  slOrderId: string | null,
  slError: string | null
): Promise<void> {
  const direction = side === 'BUY' ? '做多' : '做空';
  const displaySymbol = symbol.replace('USDC', '').replace('USDT', '');

  let statusIcon = '✅';
  let statusText = '止损已挂单';

  if (slError) {
    statusIcon = '⚠️';
    statusText = `止损挂单失败: ${slError}`;
  }

  if (!slOrderId) {
    statusIcon = '❌';
    statusText = '止损挂单失败，请手动处理';
  }

  const content = [
    `### ${statusIcon} ${displaySymbol} ${direction}成交`,
    '',
    `- **交易对**: ${displaySymbol}`,
    `- **方向**: ${direction}`,
    `- **成交价**: $${filledPrice.toFixed(2)}`,
    `- **数量**: ${quantity.toFixed(3)}`,
    `- **止损**: $${stopLossPrice.toFixed(2)} (2% 止损)`,
    `- **状态**: ${statusText}`,
  ].join('\n');

  await sendDingtalkMarkdownToUser(config!.userId, `${displaySymbol} ${direction}成交`, content);
}

/**
 * 处理止盈止损单成交（记录战绩）
 */
async function handleSlTpFilled(
  clientOrderId: string,
  order: OrderTradeUpdateEvent['order'],
  closeReason: 'sl' | 'tp' | 'trailing'
): Promise<void> {
  const closePrice = parseFloat(order.averagePrice);
  const symbol = order.symbol;

  // 解析原始入场单的 clientOrderId
  // 格式: ict_tower_4h_OB_95000_sl_1733400000 -> ict_tower_4h_OB_95000
  // 格式: BTCUSDT_normal_slxxxx -> BTCUSDT (普通订单)
  const originalId = extractOriginalOrderId(clientOrderId);
  if (!originalId) {
    console.warn(`[OrderMonitor] 无法解析原订单ID: ${clientOrderId}`);
    return;
  }

  // 查询原始入场订单 - 先尝试守塔/流动性网格订单
  const originalOrder = getPendingOrderByClientId(originalId);

  // 如果找不到，尝试普通订单（仓位监控）
  if (!originalOrder) {
    const normalEntry = normalOrderEntries.get(originalId);
    if (normalEntry) {
      // 处理普通订单平仓
      await handleNormalOrderClosed(normalEntry, closePrice, closeReason);
      normalOrderEntries.delete(originalId);
      return;
    }

    console.warn(`[OrderMonitor] 找不到原订单: ${originalId}`);
    return;
  }

  // 检查是否已经平仓过了
  if (originalOrder.status === 'closed') {
    console.log(`[OrderMonitor] 订单已平仓，跳过: ${originalId}`);
    return;
  }

  // 确保有成交价
  const entryPrice = originalOrder.filledPrice || originalOrder.entryPrice;
  if (!entryPrice) {
    console.warn(`[OrderMonitor] 订单没有成交价: ${originalId}`);
    return;
  }

  // 计算盈亏
  const pnlData = calculatePnL(originalOrder, entryPrice, closePrice, closeReason);

  // 更新数据库
  markOrderClosedWithPnL(originalId, {
    closePrice,
    closeReason,
    ...pnlData,
  });

  // 取消剩余的止盈止损单
  if (config) {
    await cancelRemainingOrders(originalOrder, {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      isTestnet: config.isTestnet,
    });
  }

  // 发送钉钉通知
  await sendCloseNotification(originalOrder, entryPrice, closePrice, closeReason, pnlData);
}

/**
 * 处理普通订单（仓位监控）平仓
 */
async function handleNormalOrderClosed(
  entry: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    entryPrice: number;
    quantity: number;
    stopLossPrice: number;
    stopLossOrderId: string | null;
    entryTime: number;
  },
  closePrice: number,
  closeReason: 'sl' | 'tp' | 'trailing'
): Promise<void> {
  const { symbol, side, positionSide, entryPrice, quantity } = entry;

  // 计算盈亏
  const isLong = positionSide === 'LONG';
  const pnlAmount = (closePrice - entryPrice) * quantity * (isLong ? 1 : -1);
  const entryCost = entryPrice * quantity;
  const pnlPercent = entryCost > 0 ? (pnlAmount / entryCost) * 100 : 0;

  const direction = side === 'BUY' ? '多' : '空';
  const displaySymbol = symbol.replace('USDC', '').replace('USDT', '');

  const reasonText = {
    sl: '止损',
    tp: '止盈',
    trailing: '追踪止盈',
  }[closeReason];

  const emoji = pnlAmount >= 0 ? '✅' : '❌';
  const pnlSign = pnlAmount >= 0 ? '+' : '';

  const content = [
    `### ${emoji} ${displaySymbol} ${direction}单平仓`,
    '',
    `- **平仓原因**: ${reasonText}`,
    `- **入场价**: $${entryPrice.toFixed(2)}`,
    `- **平仓价**: $${closePrice.toFixed(2)}`,
    `- **数量**: ${quantity.toFixed(3)}`,
    `- **盈亏**: ${pnlSign}${pnlAmount.toFixed(2)} USDT (${pnlSign}${pnlPercent.toFixed(2)}%)`,
  ].join('\n');

  console.log(`[OrderMonitor] 普通订单平仓通知: ${displaySymbol} ${direction}单 ${reasonText} ${pnlSign}${pnlAmount.toFixed(2)} USDT`);

  await sendDingtalkMarkdownToUser(config!.userId, `${displaySymbol} ${direction}单${reasonText}`, content);
}

/**
 * 从止盈止损单的 clientOrderId 解析原始入场单 ID
 * 例: ict_tower_4h_OB_95000_slxxxx -> ict_tower_4h_OB_95000
 * 例: BTCUSDT_normal_slxxxx -> BTCUSDT (普通订单)
 */
function extractOriginalOrderId(clientOrderId: string): string | null {
  // 匹配普通订单止损单: xxx_normal_slxxxx -> xxx
  const normalMatch = clientOrderId.match(/^(.+?)_normal_sl[\w]*$/);
  if (normalMatch) {
    return normalMatch[1];
  }

  // 匹配守塔/流动性网格订单止损止盈单: xxx_sl/tp/tr/trailxxxx -> xxx
  const match = clientOrderId.match(/^(.+?)_(sl|tp|tr|trail)[\w]*$/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * 计算盈亏
 */
function calculatePnL(
  order: PendingEntryOrder,
  entryPrice: number,
  closePrice: number,
  closeReason: 'sl' | 'tp' | 'trailing'
): { pnlAmount: number; pnlPercent: number; actualRR: number } {
  const quantity = order.quantity;
  const isLong = order.positionSide === 'LONG';

  // 盈亏金额 = (平仓价 - 入场价) * 数量 * 方向
  const pnlAmount = (closePrice - entryPrice) * quantity * (isLong ? 1 : -1);

  // 盈亏百分比 = 盈亏金额 / 入场成本
  const entryCost = entryPrice * quantity;
  const pnlPercent = entryCost > 0 ? (pnlAmount / entryCost) * 100 : 0;

  // 实际盈亏比 = 盈亏点数 / 风险点数
  const riskDistance = Math.abs(entryPrice - order.stopLoss);
  const pnlDistance = Math.abs(closePrice - entryPrice);

  let actualRR = 0;
  if (riskDistance > 0) {
    actualRR = pnlAmount >= 0
      ? pnlDistance / riskDistance
      : -pnlDistance / riskDistance;
  }

  return { pnlAmount, pnlPercent, actualRR };
}

/**
 * 取消剩余的止盈止损单
 * 区分普通订单和 Algo 条件单，使用不同的取消 API
 */
async function cancelRemainingOrders(
  order: PendingEntryOrder,
  apiConfig: BinanceApiConfig
): Promise<void> {
  try {
    const openOrdersResult = await getOpenOrders(apiConfig, order.symbol);
    if (!openOrdersResult.success || !openOrdersResult.orders) return;

    // 只取消当前订单的止盈止损单，通过 clientOrderId 前缀匹配
    const orderPrefix = order.clientOrderId;
    const ordersToCancel = openOrdersResult.orders.filter(o => {
      const clientId = o.clientOrderId || '';
      // 匹配格式: ict_tower_xxx_sl, ict_tower_xxx_tp, ict_tower_xxx_tr
      return clientId.startsWith(orderPrefix + '_');
    });

    for (const orderToCancel of ordersToCancel) {
      const isAlgoOrder = ['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET'].includes(orderToCancel.type);
      console.log(`[OrderMonitor] 取消剩余订单: ${orderToCancel.clientOrderId} (${orderToCancel.type}) isAlgo=${isAlgoOrder}`);

      if (isAlgoOrder) {
        // Algo 条件单使用专门的 API
        await cancelAlgoOrder(apiConfig, order.symbol, orderToCancel.orderId);
      } else {
        // 普通订单（如限价止盈单）
        await cancelOrder(apiConfig, order.symbol, orderToCancel.orderId);
      }
    }
  } catch (error) {
    console.error('[OrderMonitor] 取消剩余订单失败:', error);
  }
}

/**
 * 发送平仓通知
 */
async function sendCloseNotification(
  order: PendingEntryOrder,
  entryPrice: number,
  closePrice: number,
  closeReason: 'sl' | 'tp' | 'trailing',
  pnlData: { pnlAmount: number; pnlPercent: number; actualRR: number }
): Promise<void> {
  const direction = order.side === 'BUY' ? '多' : '空';
  const symbol = order.symbol.replace('USDC', '').replace('USDT', '');

  const reasonText = {
    sl: '止损',
    tp: '止盈',
    trailing: '追踪止盈',
  }[closeReason];

  const emoji = pnlData.pnlAmount >= 0 ? '✅' : '❌';
  const pnlSign = pnlData.pnlAmount >= 0 ? '+' : '';

  const content = [
    `### ${emoji} ${symbol} ${direction}单平仓`,
    '',
    `- **平仓原因**: ${reasonText}`,
    `- **入场价**: $${entryPrice.toFixed(2)}`,
    `- **平仓价**: $${closePrice.toFixed(2)}`,
    `- **数量**: ${order.quantity}`,
    `- **盈亏**: ${pnlSign}${pnlData.pnlAmount.toFixed(2)} USDT (${pnlSign}${pnlData.pnlPercent.toFixed(2)}%)`,
    `- **盈亏比**: ${pnlData.actualRR.toFixed(2)}R`,
  ].join('\n');

  await sendDingtalkMarkdownToUser(config!.userId, `${symbol} ${direction}单${reasonText}`, content);
}

/**
 * 发送入场成交通知
 */
async function sendEntryFilledNotification(
  order: PendingEntryOrder,
  filledPrice: number,
  slOrderId: string | null,
  tpOrderId: string | null,
  errors: string[]
): Promise<void> {
  const direction = order.side === 'BUY' ? '做多' : '做空';
  const symbol = order.symbol.replace('USDC', '').replace('USDT', '');

  // 计算盈亏比
  const riskDistance = Math.abs(filledPrice - order.stopLoss);
  const rewardDistance = Math.abs(order.takeProfit - filledPrice);
  const riskReward = riskDistance > 0 ? (rewardDistance / riskDistance).toFixed(1) : 'N/A';

  // 追踪止盈激活价（使用订单配置）
  const activationRatio = order.trailingActivationRatio;
  const callbackRate = order.trailingCallbackRate;
  const trailingActivationPrice = order.positionSide === 'LONG'
    ? filledPrice * (1 + activationRatio)
    : filledPrice * (1 - activationRatio);

  let statusIcon = '✅';
  let statusText = '止损+双止盈已挂单';

  if (errors.length > 0) {
    statusIcon = '⚠️';
    statusText = `部分失败: ${errors.join(', ')}`;
  }

  if (!slOrderId && !tpOrderId) {
    statusIcon = '❌';
    statusText = '止盈止损均失败，请手动处理';
  }

  const content = [
    `### ${statusIcon} 入场单成交`,
    '',
    `- **交易对**: ${symbol}`,
    `- **方向**: ${direction}`,
    `- **成交价**: $${filledPrice.toFixed(2)}`,
    `- **数量**: ${order.quantity}`,
    `- **止损**: $${order.stopLoss.toFixed(2)}`,
    `- **固定止盈**: $${order.takeProfit.toFixed(2)} (保底)`,
    `- **追踪止盈**: 激活价 $${trailingActivationPrice.toFixed(2)} (盈利${(activationRatio * 100).toFixed(2)}%), 回撤${callbackRate}%触发`,
    `- **盈亏比**: 1:${riskReward}`,
    '',
    `**状态**: ${statusText}`,
  ].join('\n');

  await sendDingtalkMarkdownToUser(config!.userId, `${symbol} ${direction}成交`, content);
}

/**
 * 启动订单监控服务
 */
export async function startOrderMonitor(cfg: OrderMonitorConfig): Promise<void> {
  if (streamManager) {
    console.log('[OrderMonitor] 已在运行中');
    return;
  }

  console.log('[OrderMonitor] 启动订单监控服务...');

  config = cfg;

  // 初始化数据库表
  initPendingOrdersTable();

  // 清理过期订单
  cleanupOldPendingOrders();

  // 创建 Binance User Data Stream 管理器
  streamManager = new UserDataStreamManager({
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    isTestnet: cfg.isTestnet,
    onOrderUpdate: handleOrderFilled,
    onConnected: () => {
      console.log('[OrderMonitor] Binance WebSocket 已连接');
    },
    onDisconnected: () => {
      console.log('[OrderMonitor] Binance WebSocket 已断开');
    },
    onError: (error) => {
      console.error('[OrderMonitor] Binance WebSocket 错误:', error);
    },
  });

  // 启动 Binance WebSocket 连接
  await streamManager.start();

  // 如果有 Aster 配置，也启动 Aster 监听
  if (cfg.asterApiKey && cfg.asterApiSecret) {
    console.log('[OrderMonitor] 启动 Aster 监听...');
    asterStreamManager = new AsterUserDataStreamManager({
      apiKey: cfg.asterApiKey,
      apiSecret: cfg.asterApiSecret,
      onOrderUpdate: handleOrderFilled,
      onConnected: () => {
        console.log('[OrderMonitor] Aster WebSocket 已连接');
      },
      onDisconnected: () => {
        console.log('[OrderMonitor] Aster WebSocket 已断开');
      },
      onError: (error) => {
        console.error('[OrderMonitor] Aster WebSocket 错误:', error);
      },
    });
    await asterStreamManager.start();
  }

  // 定期清理过期订单 (每小时)
  cleanupInterval = setInterval(() => {
    cleanupOldPendingOrders();
    cleanupCanceledOrders();
  }, 60 * 60 * 1000);

  // 启动时也清理一次已取消订单
  cleanupCanceledOrders();

  // 打印统计信息
  const stats = getOrderStats();
  console.log('[OrderMonitor] 订单统计:', stats);

  console.log('[OrderMonitor] 订单监控服务已启动');
}

/**
 * 停止订单监控服务
 */
export function stopOrderMonitor(): void {
  if (streamManager) {
    streamManager.stop();
    streamManager = null;
  }

  if (asterStreamManager) {
    asterStreamManager.stop();
    asterStreamManager = null;
  }

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  config = null;

  console.log('[OrderMonitor] 订单监控服务已停止');
}

/**
 * 检查监控器是否运行中
 */
export function isOrderMonitorRunning(): boolean {
  return streamManager?.isActive() ?? false;
}

/**
 * 获取监控器状态
 */
export function getOrderMonitorStatus(): {
  running: boolean;
  stats: ReturnType<typeof getOrderStats>;
} {
  return {
    running: isOrderMonitorRunning(),
    stats: getOrderStats(),
  };
}
