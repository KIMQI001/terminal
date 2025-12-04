/**
 * 守塔托管调度器
 * 后台定时执行守塔策略
 */

import {
  getActiveManagements,
  updateRunTime,
  addRecord,
  TowerManagementConfig,
  initTowerManagementTables,
} from './towerManagementStore';
import { getBinanceApiConfig } from '../order/apiConfigReader';
import { fetchTowerBlocks } from './towerBlocksFetcher';
import { sendDingtalkMarkdown } from '../notification/dingtalk';

// 调度器状态
let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

// 止损止盈参数
const MAX_SL_DISTANCE = 200;
const MIN_TP_DISTANCE = 1000;
const MIN_DISTANCE_RATIO = 0.003; // 千分之三

/**
 * 启动托管调度器
 */
export function startTowerScheduler(): void {
  if (schedulerInterval) {
    console.log('[TowerScheduler] 调度器已在运行');
    return;
  }

  // 初始化数据库表
  initTowerManagementTables();

  console.log('[TowerScheduler] 启动托管调度器...');

  // 每 30 秒检查一次
  schedulerInterval = setInterval(async () => {
    if (isRunning) return;

    try {
      isRunning = true;
      await checkAndExecute();
    } catch (error) {
      console.error('[TowerScheduler] 执行错误:', error);
    } finally {
      isRunning = false;
    }
  }, 30 * 1000);

  console.log('[TowerScheduler] 托管调度器已启动');
}

/**
 * 停止托管调度器
 */
export function stopTowerScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[TowerScheduler] 托管调度器已停止');
  }
}

/**
 * 检查并执行到期的托管任务
 */
async function checkAndExecute(): Promise<void> {
  const now = Date.now();
  const activeManagements = getActiveManagements();

  for (const management of activeManagements) {
    if (!management.nextRunAt) continue;

    const nextRunTime = new Date(management.nextRunAt).getTime();
    if (now >= nextRunTime) {
      console.log(`[TowerScheduler] 执行托管: userId=${management.userId}, symbol=${management.symbol}`);
      await executeTowerManagement(management);
    }
  }
}

/**
 * 执行托管任务
 */
async function executeTowerManagement(management: TowerManagementConfig): Promise<void> {
  const startTime = Date.now();

  try {
    // 获取用户 API 配置
    const apiConfig = getBinanceApiConfig(management.userId);
    if (!apiConfig) {
      console.error(`[TowerScheduler] 用户 ${management.userId} 没有 API 配置`);
      addRecord({
        managementId: management.id,
        bullishCount: 0,
        bearishCount: 0,
        totalMargin: 0,
        success: false,
        skipped: false,
        errorMessage: '没有 API 配置',
      });
      updateRunTime(management.id);
      return;
    }

    // 1. 检查当前订单数量
    const orderCheck = await checkOrdersCount(apiConfig, management.symbol, management.towerLayers);
    if (orderCheck.sufficient) {
      console.log(`[TowerScheduler] 订单充足，跳过: 多${orderCheck.bullish}空${orderCheck.bearish}`);
      addRecord({
        managementId: management.id,
        bullishCount: orderCheck.bullish,
        bearishCount: orderCheck.bearish,
        totalMargin: 0,
        success: true,
        skipped: true,
        errorMessage: undefined, // 跳过不是错误，不设置 errorMessage
      });
      updateRunTime(management.id);
      return;
    }

    // 2. 获取塔块数据
    const towerData = await fetchTowerBlocks(management.symbol);
    if (!towerData || !towerData.blocks.length) {
      console.error(`[TowerScheduler] 获取塔块数据失败: ${management.symbol}`);
      addRecord({
        managementId: management.id,
        bullishCount: 0,
        bearishCount: 0,
        totalMargin: 0,
        success: false,
        skipped: false,
        errorMessage: '获取塔块数据失败',
      });
      updateRunTime(management.id);
      return;
    }

    // 3. 取消现有订单
    const cancelResult = await cancelAllTowerOrders(apiConfig, management.symbol);
    if (!cancelResult.success) {
      console.error(`[TowerScheduler] 取消订单失败: ${cancelResult.error}`);
      addRecord({
        managementId: management.id,
        bullishCount: 0,
        bearishCount: 0,
        totalMargin: 0,
        success: false,
        skipped: false,
        errorMessage: `取消订单失败: ${cancelResult.error}`,
      });
      updateRunTime(management.id);
      return;
    }

    // 等待订单取消完成
    await delay(500);

    // 4. 计算要下的订单
    const orders = calculateOrders(towerData, management);
    if (orders.length === 0) {
      console.log('[TowerScheduler] 没有符合条件的塔块');
      addRecord({
        managementId: management.id,
        bullishCount: 0,
        bearishCount: 0,
        totalMargin: 0,
        success: true,
        skipped: true,
        errorMessage: '没有符合条件的塔块',
      });
      updateRunTime(management.id);
      return;
    }

    // 5. 下单
    const result = await placeOrders(apiConfig, management.symbol, orders);

    // 6. 记录结果
    const bullishCount = orders.filter(o => o.side === 'BUY').length;
    const bearishCount = orders.filter(o => o.side === 'SELL').length;
    const totalMargin = orders.reduce((sum, o) => sum + o.margin, 0);

    addRecord({
      managementId: management.id,
      bullishCount,
      bearishCount,
      totalMargin,
      success: result.errors.length === 0,
      skipped: false,
      errorMessage: result.errors.length > 0 ? result.errors.join('; ') : undefined,
    });

    // 更新执行时间
    updateRunTime(management.id);

    const duration = Date.now() - startTime;
    console.log(`[TowerScheduler] 执行完成: ${orders.length}单, ${result.errors.length}错误, 耗时${duration}ms`);

    // 发送钉钉通知（如果有错误）
    if (result.errors.length > 0) {
      await sendDingtalkMarkdown(
        '守塔托管告警',
        `### 守塔托管执行有错误\n\n` +
        `- **交易对**: ${management.symbol}\n` +
        `- **下单数**: ${orders.length}\n` +
        `- **错误数**: ${result.errors.length}\n` +
        `- **错误**: ${result.errors.slice(0, 3).join(', ')}`
      );
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[TowerScheduler] 执行异常:`, error);

    addRecord({
      managementId: management.id,
      bullishCount: 0,
      bearishCount: 0,
      totalMargin: 0,
      success: false,
      skipped: false,
      errorMessage: errorMsg,
    });

    updateRunTime(management.id);
  }
}

/**
 * 检查订单数量
 */
async function checkOrdersCount(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string,
  requiredLayers: number
): Promise<{ bullish: number; bearish: number; sufficient: boolean }> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString, apiConfig.apiSecret);

    const response = await fetch(
      `${baseUrl}/fapi/v1/openOrders?${queryString}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': apiConfig.apiKey } }
    );

    if (!response.ok) {
      return { bullish: 0, bearish: 0, sufficient: false };
    }

    const orders = await response.json() as Array<{
      clientOrderId: string;
      side: string;
      type: string;
    }>;

    // 只统计 ict_tower 前缀的限价单
    const towerOrders = orders.filter(
      o => o.clientOrderId?.startsWith('ict_tower') && o.type === 'LIMIT'
    );

    const bullish = towerOrders.filter(o => o.side === 'BUY').length;
    const bearish = towerOrders.filter(o => o.side === 'SELL').length;
    const sufficient = bullish >= requiredLayers && bearish >= requiredLayers;

    return { bullish, bearish, sufficient };
  } catch (error) {
    console.error('[TowerScheduler] 检查订单失败:', error);
    return { bullish: 0, bearish: 0, sufficient: false };
  }
}

/**
 * 取消所有守塔订单
 */
async function cancelAllTowerOrders(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString, apiConfig.apiSecret);

    const response = await fetch(
      `${baseUrl}/fapi/v1/allOpenOrders?${queryString}&signature=${signature}`,
      {
        method: 'DELETE',
        headers: { 'X-MBX-APIKEY': apiConfig.apiKey },
      }
    );

    if (!response.ok) {
      const data = await response.json() as { msg?: string };
      return { success: false, error: data.msg || `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络错误',
    };
  }
}

/**
 * 计算要下的订单
 */
interface TowerOrder {
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  price: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  margin: number;
}

function calculateOrders(
  towerData: { currentPrice: number; blocks: Array<{ type: string; entry: number; high: number; low: number; source: string; timeframe: string }> },
  management: TowerManagementConfig
): TowerOrder[] {
  const { currentPrice, blocks } = towerData;
  const { baseMargin, marginIncrement, towerLayers, bullishStartLayer, bearishStartLayer, minSpacingRatio } = management;

  // 分离多空并添加止损止盈
  const allBearish = blocks
    .filter(b => b.type === 'bearish')
    .map(b => ({
      ...b,
      stopLoss: 0,
      takeProfit: 0,
    }))
    .sort((a, b) => b.entry - a.entry);

  const allBullish = blocks
    .filter(b => b.type === 'bullish')
    .map(b => ({
      ...b,
      stopLoss: 0,
      takeProfit: 0,
    }))
    .sort((a, b) => b.entry - a.entry);

  // 计算止损止盈
  for (const block of [...allBearish, ...allBullish]) {
    // 止损 = 边界，最大 200 点
    const boundary = block.type === 'bearish' ? block.high : block.low;
    const slDistance = Math.abs(block.entry - boundary);

    if (slDistance > MAX_SL_DISTANCE) {
      block.stopLoss = block.type === 'bearish'
        ? block.entry + MAX_SL_DISTANCE
        : block.entry - MAX_SL_DISTANCE;
    } else {
      block.stopLoss = boundary;
    }

    // 止盈 = 最近的对立塔块，最小 1000 点
    let target: typeof block | undefined;

    if (block.type === 'bearish') {
      const candidates = allBullish.filter(b => b.entry < block.entry);
      target = candidates[0];
    } else {
      const candidates = allBearish.filter(b => b.entry > block.entry);
      target = candidates[candidates.length - 1];
    }

    if (target) {
      const tpDistance = Math.abs(target.entry - block.entry);
      if (tpDistance >= MIN_TP_DISTANCE) {
        block.takeProfit = target.entry;
      } else {
        block.takeProfit = block.type === 'bearish'
          ? block.entry - MIN_TP_DISTANCE
          : block.entry + MIN_TP_DISTANCE;
      }
    } else {
      block.takeProfit = block.type === 'bearish'
        ? block.entry - MIN_TP_DISTANCE
        : block.entry + MIN_TP_DISTANCE;
    }
  }

  // 最小距离（千分之三）
  const minDistance = currentPrice * MIN_DISTANCE_RATIO;
  // 最小间距（万分之 N）
  const minSpacing = currentPrice * (minSpacingRatio / 10000);

  // 筛选函数：保证相邻塔块间距 >= minSpacing
  const filterWithSpacing = (
    blockList: typeof allBullish,
    startLayer: number,
    count: number
  ) => {
    const result: typeof blockList = [];
    let skipped = 0;
    let lastEntry: number | null = null;

    for (const block of blockList) {
      if (lastEntry !== null) {
        const spacing = Math.abs(block.entry - lastEntry);
        if (spacing < minSpacing) continue;
      }

      if (skipped < startLayer - 1) {
        skipped++;
        continue;
      }

      result.push(block);
      lastEntry = block.entry;

      if (result.length >= count) break;
    }

    return result;
  };

  // 筛选塔块
  const bullishCandidates = allBullish
    .filter(b => b.entry < currentPrice && currentPrice - b.entry >= minDistance)
    .sort((a, b) => b.entry - a.entry);

  const bearishCandidates = allBearish
    .filter(b => b.entry > currentPrice && b.entry - currentPrice >= minDistance)
    .sort((a, b) => a.entry - b.entry);

  const selectedBullish = filterWithSpacing(bullishCandidates, bullishStartLayer, towerLayers);
  const selectedBearish = filterWithSpacing(bearishCandidates, bearishStartLayer, towerLayers);

  // 转换为订单
  const orders: TowerOrder[] = [];

  // 获取杠杆（假设 20x，实际应该从 API 获取）
  const leverage = 20;

  for (let i = 0; i < selectedBullish.length; i++) {
    const block = selectedBullish[i];
    const margin = baseMargin + i * marginIncrement;
    const positionValue = margin * leverage;
    const quantity = Math.floor((positionValue / block.entry) * 1000) / 1000;

    orders.push({
      side: 'BUY',
      positionSide: 'LONG',
      price: block.entry,
      quantity,
      stopLoss: block.stopLoss,
      takeProfit: block.takeProfit,
      margin,
    });
  }

  for (let i = 0; i < selectedBearish.length; i++) {
    const block = selectedBearish[i];
    const margin = baseMargin + i * marginIncrement;
    const positionValue = margin * leverage;
    const quantity = Math.floor((positionValue / block.entry) * 1000) / 1000;

    orders.push({
      side: 'SELL',
      positionSide: 'SHORT',
      price: block.entry,
      quantity,
      stopLoss: block.stopLoss,
      takeProfit: block.takeProfit,
      margin,
    });
  }

  return orders;
}

/**
 * 下单
 */
async function placeOrders(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string,
  orders: TowerOrder[]
): Promise<{ success: number; errors: string[] }> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  let success = 0;
  const errors: string[] = [];

  for (const order of orders) {
    try {
      const timestamp = Date.now();
      const clientOrderId = `ict_tower_${timestamp}_${Math.random().toString(36).substring(2, 8)}`;

      const params: Record<string, string | number> = {
        symbol,
        side: order.side,
        positionSide: order.positionSide,
        type: 'LIMIT',
        quantity: order.quantity.toFixed(3),
        price: order.price.toFixed(1),
        timeInForce: 'GTC',
        newClientOrderId: clientOrderId,
        timestamp,
      };

      const queryString = Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const signature = generateSignature(queryString, apiConfig.apiSecret);

      const response = await fetch(`${baseUrl}/fapi/v1/order`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiConfig.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `${queryString}&signature=${signature}`,
      });

      if (!response.ok) {
        const data = await response.json() as { msg?: string };
        errors.push(`${order.side} @ ${order.price}: ${data.msg || response.status}`);
        continue;
      }

      success++;

      // 保存待处理订单（用于成交后下止盈止损）
      await savePendingOrder({
        clientOrderId,
        symbol,
        side: order.side,
        positionSide: order.positionSide,
        quantity: order.quantity,
        entryPrice: order.price,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
      });

      // 延迟避免请求过快
      await delay(200);
    } catch (error) {
      errors.push(`${order.side} @ ${order.price}: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  return { success, errors };
}

/**
 * 保存待处理订单
 */
async function savePendingOrder(params: {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}): Promise<void> {
  // 直接调用 pendingOrderStore
  const { addPendingOrder } = await import('../order/pendingOrderStore');
  addPendingOrder(params);
}

/**
 * 生成签名
 */
function generateSignature(queryString: string, apiSecret: string): string {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

/**
 * 延迟
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 检查调度器是否运行
 */
export function isSchedulerRunning(): boolean {
  return schedulerInterval !== null;
}
