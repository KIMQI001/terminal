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
  initPendingOrdersTable,
  cleanupOldPendingOrders,
  getOrderStats,
  PendingEntryOrder,
} from './pendingOrderStore';
import {
  placeTakeProfitOrder,
  placeStopLossOrder,
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

  // 快速过滤：只处理 ict_tower 前缀的订单
  if (!clientOrderId.startsWith('ict_tower')) {
    return;
  }

  // 跳过止盈止损单 (后缀 _sl, _tp)
  if (clientOrderId.includes('_sl') || clientOrderId.includes('_tp')) {
    if (order.orderStatus === 'FILLED') {
      const isTp = clientOrderId.includes('_tp');
      console.log(`[OrderMonitor] ${symbol} ${isTp ? '止盈' : '止损'}单成交: ${clientOrderId} @ ${order.averagePrice}`);
    }
    return;
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
    await handleEntryFilled(clientOrderId, order, pendingOrder);
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
    // 下止损平仓限价单
    console.log(`[OrderMonitor] 下止损单: ${pendingOrder.stopLoss}`);
    const slResult = await placeStopLossOrder(apiConfig, {
      symbol: pendingOrder.symbol,
      side: closeSide,
      positionSide: pendingOrder.positionSide,
      quantity: pendingOrder.quantity,
      stopPrice: pendingOrder.stopLoss,
      clientOrderId: `${clientOrderId}_sl`,
    });

    if (slResult.success) {
      slOrderId = slResult.orderId?.toString() || null;
      console.log(`[OrderMonitor] 止损单下单成功: ${slOrderId}`);
    } else {
      errors.push(`止损单失败: ${slResult.error}`);
      console.error(`[OrderMonitor] 止损单失败: ${slResult.error}`);
    }

    // 下止盈平仓限价单
    console.log(`[OrderMonitor] 下止盈单: ${pendingOrder.takeProfit}`);
    const tpResult = await placeTakeProfitOrder(apiConfig, {
      symbol: pendingOrder.symbol,
      side: closeSide,
      positionSide: pendingOrder.positionSide,
      quantity: pendingOrder.quantity,
      takeProfitPrice: pendingOrder.takeProfit,
      clientOrderId: `${clientOrderId}_tp`,
    });

    if (tpResult.success) {
      tpOrderId = tpResult.orderId?.toString() || null;
      console.log(`[OrderMonitor] 止盈单下单成功: ${tpOrderId}`);
    } else {
      errors.push(`止盈单失败: ${tpResult.error}`);
      console.error(`[OrderMonitor] 止盈单失败: ${tpResult.error}`);
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
 * 处理入场单取消
 */
async function handleEntryCanceled(clientOrderId: string): Promise<void> {
  console.log(`[OrderMonitor] 入场单已取消: ${clientOrderId}`);
  markOrderCanceled(clientOrderId);
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

  let statusIcon = '✅';
  let statusText = '止盈止损已挂单';

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
    `- **止盈**: $${order.takeProfit.toFixed(2)}`,
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
