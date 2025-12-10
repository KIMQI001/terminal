/**
 * 订单监控主模块
 * 监听入场单成交，自动下止盈止损平仓限价单
 */

import { UserDataStreamManager, OrderTradeUpdateEvent } from './userDataStream';
import {
  getPendingOrderByClientId,
  markOrderFilled,
  markSlTpPlaced,
  markOrderCanceled,
  markOrderError,
  markOrderClosedWithPnL,
  initPendingOrdersTable,
  cleanupOldPendingOrders,
  getOrderStats,
  PendingEntryOrder,
} from './pendingOrderStore';
import {
  placeStopLossOrder,
  placeTakeProfitOrder,
  placeTrailingStopOrder,
  getOpenOrders,
  cancelOrder,
  BinanceApiConfig,
} from './binanceOrderApi';
import { sendDingtalkMarkdown } from '../notification/dingtalk';

// 订单监控器配置
export interface OrderMonitorConfig {
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
}

let streamManager: UserDataStreamManager | null = null;
let config: OrderMonitorConfig | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * 处理订单成交事件
 * 只处理数据库中存在的待处理订单（通过 clientOrderId 匹配）
 */
async function handleOrderFilled(event: OrderTradeUpdateEvent): Promise<void> {
  const { order } = event;
  const clientOrderId = order.clientOrderId;
  const symbol = order.symbol;

  // 快速过滤：只处理 ict_tower 或 liq_grid 前缀的订单
  const isTowerOrder = clientOrderId.startsWith('ict_tower');
  const isLiqGridOrder = clientOrderId.startsWith('liq_grid');

  if (!isTowerOrder && !isLiqGridOrder) {
    return;
  }

  // 处理止盈止损单成交（记录战绩）
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
    // 先检查是否已有止盈止损单（入场时可能已经下过了）
    const existingOrdersResult = await getOpenOrders(apiConfig, pendingOrder.symbol);
    const existingOrders = existingOrdersResult.success ? (existingOrdersResult.orders || []) : [];

    // 检查是否已有止损单
    const hasStopLoss = existingOrders.some(o =>
      o.positionSide === pendingOrder.positionSide &&
      o.type === 'STOP_MARKET'
    );

    // 检查是否已有止盈单
    const hasTakeProfit = existingOrders.some(o =>
      o.positionSide === pendingOrder.positionSide &&
      (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TRAILING_STOP_MARKET')
    );

    // 检查是否已有追踪止盈
    const hasTrailingStop = existingOrders.some(o =>
      o.positionSide === pendingOrder.positionSide &&
      o.type === 'TRAILING_STOP_MARKET'
    );

    console.log(`[OrderMonitor] 检查现有订单: 止损=${hasStopLoss}, 止盈=${hasTakeProfit}, 追踪=${hasTrailingStop}`);

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
      // activationPrice: 盈利2%后激活追踪
      // callbackRate: 从最高价回撤0.3%后触发止盈
      const trailingActivationPrice = pendingOrder.positionSide === 'LONG'
        ? filledPrice * 1.02   // 多单：价格上涨2%后激活
        : filledPrice * 0.98;  // 空单：价格下跌2%后激活

      const trailSuffix = Math.random().toString(36).slice(-4);
      const trailClientId = `${clientOrderId}_tr${trailSuffix}`;
      console.log(`[OrderMonitor] 下追踪止盈单: 激活价=${trailingActivationPrice.toFixed(2)}, 回撤=0.3%`);
      const trailingTpResult = await placeTrailingStopOrder(apiConfig, {
        symbol: pendingOrder.symbol,
        side: closeSide,
        positionSide: pendingOrder.positionSide,
        quantity: pendingOrder.quantity,
        callbackRate: 0.3,              // 0.3% 回撤触发
        activationPrice: trailingActivationPrice,  // 盈利2%后激活
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
    await sendDingtalkMarkdown(
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
 * 处理流动性网格订单入场成交
 * 只下止盈单，不下止损单，不下追踪止盈
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

  let tpOrderId: string | null = null;
  const errors: string[] = [];

  try {
    // 检查是否已有止盈单
    const existingOrdersResult = await getOpenOrders(apiConfig, pendingOrder.symbol);
    const existingOrders = existingOrdersResult.success ? (existingOrdersResult.orders || []) : [];

    const hasTakeProfit = existingOrders.some(o =>
      o.positionSide === pendingOrder.positionSide &&
      o.type === 'TAKE_PROFIT_MARKET'
    );

    console.log(`[LiqGrid] 检查现有订单: 止盈=${hasTakeProfit}`);

    // 只下止盈单（如果有 takeProfit 且 > 0）
    if (!hasTakeProfit && pendingOrder.takeProfit > 0) {
      const tpSuffix = Math.random().toString(36).slice(-4);
      const tpClientId = `${clientOrderId}_tp${tpSuffix}`;
      console.log(`[LiqGrid] 下止盈单: ${pendingOrder.takeProfit}`);

      const tpResult = await placeTakeProfitOrder(apiConfig, {
        symbol: pendingOrder.symbol,
        side: closeSide,
        positionSide: pendingOrder.positionSide,
        quantity: pendingOrder.quantity,
        takeProfitPrice: pendingOrder.takeProfit,
        clientOrderId: tpClientId,
      });

      if (tpResult.success) {
        tpOrderId = tpResult.orderId?.toString() || null;
        console.log(`[LiqGrid] 止盈单下单成功: ${tpClientId}`);
      } else {
        errors.push(`止盈单失败: ${tpResult.error}`);
        console.error(`[LiqGrid] 止盈单失败: ${tpResult.error}`);
      }
    } else if (hasTakeProfit) {
      console.log(`[LiqGrid] 止盈单已存在，跳过`);
      tpOrderId = 'exists';
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
    await sendDingtalkMarkdown(
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

  await sendDingtalkMarkdown(`${symbol} 流动性网格${direction}成交`, content);
}

/**
 * 处理入场单取消
 */
async function handleEntryCanceled(clientOrderId: string): Promise<void> {
  console.log(`[OrderMonitor] 入场单已取消: ${clientOrderId}`);
  markOrderCanceled(clientOrderId);
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
  const originalId = extractOriginalOrderId(clientOrderId);
  if (!originalId) {
    console.warn(`[OrderMonitor] 无法解析原订单ID: ${clientOrderId}`);
    return;
  }

  // 查询原始入场订单
  const originalOrder = getPendingOrderByClientId(originalId);
  if (!originalOrder) {
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
 * 从止盈止损单的 clientOrderId 解析原始入场单 ID
 * 例: ict_tower_4h_OB_95000_slxxxx -> ict_tower_4h_OB_95000
 */
function extractOriginalOrderId(clientOrderId: string): string | null {
  // 匹配 _sl, _tp, _tr 后缀（新格式4字符后缀，旧格式时间戳后缀）
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
      console.log(`[OrderMonitor] 取消剩余订单: ${orderToCancel.clientOrderId} (${orderToCancel.type})`);
      await cancelOrder(apiConfig, order.symbol, orderToCancel.orderId);
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

  await sendDingtalkMarkdown(`${symbol} ${direction}单${reasonText}`, content);
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

  // 追踪止盈激活价
  const trailingActivationPrice = order.positionSide === 'LONG'
    ? filledPrice * 1.02
    : filledPrice * 0.98;

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
    `- **追踪止盈**: 激活价 $${trailingActivationPrice.toFixed(2)} (盈利2%), 回撤0.3%触发`,
    `- **盈亏比**: 1:${riskReward}`,
    '',
    `**状态**: ${statusText}`,
  ].join('\n');

  await sendDingtalkMarkdown(`${symbol} ${direction}成交`, content);
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

  // 创建 User Data Stream 管理器
  streamManager = new UserDataStreamManager({
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    isTestnet: cfg.isTestnet,
    onOrderUpdate: handleOrderFilled,
    onConnected: () => {
      console.log('[OrderMonitor] WebSocket 已连接');
    },
    onDisconnected: () => {
      console.log('[OrderMonitor] WebSocket 已断开');
    },
    onError: (error) => {
      console.error('[OrderMonitor] WebSocket 错误:', error);
    },
  });

  // 启动 WebSocket 连接
  await streamManager.start();

  // 定期清理过期订单 (每小时)
  cleanupInterval = setInterval(() => {
    cleanupOldPendingOrders();
  }, 60 * 60 * 1000);

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
