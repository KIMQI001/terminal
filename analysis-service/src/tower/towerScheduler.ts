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

// 时间周期优先级（同距离时大级别优先）
const TIMEFRAME_PRIORITY: Record<string, number> = {
  '1d': 5, '4h': 4, '1h': 3, '15m': 2, '5m': 1
};

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

// 仓位监控计数器
let positionMonitorCounter = 0;
const POSITION_MONITOR_INTERVAL = 2; // 每 2 次调度循环监控一次（即每 60 秒）

// 数据库清理计数器
let cleanupCounter = 0;
const CLEANUP_INTERVAL = 120; // 每 120 次调度循环清理一次（即每 1 小时）

/**
 * 检查并执行到期的托管任务
 */
async function checkAndExecute(): Promise<void> {
  const now = Date.now();
  const activeManagements = getActiveManagements();

  // 执行到期的托管任务
  for (const management of activeManagements) {
    if (!management.nextRunAt) continue;

    const nextRunTime = new Date(management.nextRunAt).getTime();
    if (now >= nextRunTime) {
      console.log(`[TowerScheduler] 执行托管: userId=${management.userId}, symbol=${management.symbol}`);
      await executeTowerManagement(management);
    }
  }

  // 定期执行仓位监控（每 60 秒）
  positionMonitorCounter++;
  if (positionMonitorCounter >= POSITION_MONITOR_INTERVAL) {
    positionMonitorCounter = 0;
    console.log('[TowerScheduler] 执行仓位监控...');
    await monitorAndRepairPositions();
  }

  // 定期清理数据库（每 1 小时）
  cleanupCounter++;
  if (cleanupCounter >= CLEANUP_INTERVAL) {
    cleanupCounter = 0;
    const { cleanupCanceledOrders, cleanupOldPendingOrders } = await import('../order/pendingOrderStore');
    cleanupOldPendingOrders();
    cleanupCanceledOrders();
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

    // 1. 检查是否有持仓（有持仓时跳过，避免取消止盈止损单）
    const { getPositions } = await import('../order/binanceOrderApi');
    const positionsResult = await getPositions(apiConfig, management.symbol);
    if (positionsResult.success && positionsResult.positions && positionsResult.positions.length > 0) {
      const positions = positionsResult.positions.filter(p => Math.abs(p.positionAmt) >= 0.001);
      if (positions.length > 0) {
        console.log(`[TowerScheduler] 有持仓，跳过更新: ${positions.map(p => `${p.positionSide} ${p.positionAmt}`).join(', ')}`);
        addRecord({
          managementId: management.id,
          bullishCount: 0,
          bearishCount: 0,
          totalMargin: 0,
          success: true,
          skipped: true,
          errorMessage: undefined,
        });
        updateRunTime(management.id);
        return;
      }
    }

    // 2. 检查当前订单数量和位置
    const orderCheck = await checkOrdersCount(apiConfig, management.symbol, management.towerLayers);
    if (orderCheck.sufficient || orderCheck.hasNearOrder) {
      const reason = orderCheck.hasNearOrder ? '有订单在当前价附近' : `订单充足 多${orderCheck.bullish}空${orderCheck.bearish}`;
      console.log(`[TowerScheduler] 跳过更新: ${reason}`);
      addRecord({
        managementId: management.id,
        bullishCount: orderCheck.bullish,
        bearishCount: orderCheck.bearish,
        totalMargin: 0,
        success: true,
        skipped: true,
        errorMessage: undefined,
      });
      updateRunTime(management.id);
      return;
    }

    // 3. 获取塔块数据
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

    // 4. 取消现有订单
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

    // 5. 获取杠杆
    const leverage = await getLeverage(apiConfig, management.symbol);

    // 6. 计算要下的订单
    const orders = calculateOrders(towerData, management, leverage);
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

    // 7. 下单
    const result = await placeOrders(apiConfig, management.symbol, orders);

    // 8. 记录结果
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
    console.log(`[TowerScheduler] 执行完成: ${orders.length}单(入场+止盈止损), 杠杆=${leverage}x, 总保证金=${totalMargin} USDT, ${result.errors.length}错误, 耗时${duration}ms`);

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

// 当前价格附近订单检查阈值（百分之一 = 1%）
const NEAR_PRICE_RATIO = 1 / 100;

/**
 * 检查订单数量
 */
async function checkOrdersCount(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string,
  requiredLayers: number
): Promise<{ bullish: number; bearish: number; sufficient: boolean; hasNearOrder: boolean }> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString, apiConfig.apiSecret);

    // 并行获取订单和当前价格
    const [ordersResponse, priceResponse] = await Promise.all([
      fetch(
        `${baseUrl}/fapi/v1/openOrders?${queryString}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': apiConfig.apiKey } }
      ),
      fetch(`${baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`)
    ]);

    if (!ordersResponse.ok) {
      return { bullish: 0, bearish: 0, sufficient: false, hasNearOrder: false };
    }

    const orders = await ordersResponse.json() as Array<{
      clientOrderId: string;
      side: string;
      type: string;
      price: string;
    }>;

    // 获取当前价格
    let currentPrice = 0;
    if (priceResponse.ok) {
      const priceData = await priceResponse.json() as { price: string };
      currentPrice = parseFloat(priceData.price);
    }

    // 只统计 ict_tower 前缀的限价单
    const towerOrders = orders.filter(
      o => o.clientOrderId?.startsWith('ict_tower') && o.type === 'LIMIT'
    );

    const bullish = towerOrders.filter(o => o.side === 'BUY').length;
    const bearish = towerOrders.filter(o => o.side === 'SELL').length;
    const sufficient = bullish >= requiredLayers && bearish >= requiredLayers;

    // 检查是否有订单在当前价格附近（百分之一 = 1%）
    let hasNearOrder = false;
    if (currentPrice > 0) {
      const nearDistance = currentPrice * NEAR_PRICE_RATIO;
      hasNearOrder = towerOrders.some(o => {
        const orderPrice = parseFloat(o.price);
        return Math.abs(orderPrice - currentPrice) <= nearDistance;
      });
      if (hasNearOrder) {
        console.log(`[TowerScheduler] 有订单在当前价 ${currentPrice.toFixed(1)} 附近（±${nearDistance.toFixed(0)}）`);
      }
    }

    return { bullish, bearish, sufficient, hasNearOrder };
  } catch (error) {
    console.error('[TowerScheduler] 检查订单失败:', error);
    return { bullish: 0, bearish: 0, sufficient: false, hasNearOrder: false };
  }
}

/**
 * 获取杠杆倍数
 */
async function getLeverage(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string
): Promise<number> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString, apiConfig.apiSecret);

    const response = await fetch(
      `${baseUrl}/fapi/v2/positionRisk?${queryString}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': apiConfig.apiKey } }
    );

    if (!response.ok) {
      console.warn('[TowerScheduler] 获取杠杆失败，使用默认值 20x');
      return 20;
    }

    const positions = await response.json() as Array<{
      symbol: string;
      leverage: string;
    }>;

    const position = positions.find(p => p.symbol === symbol);
    if (position) {
      const leverage = parseInt(position.leverage, 10);
      console.log(`[TowerScheduler] 获取杠杆: ${symbol} = ${leverage}x`);
      return leverage;
    }

    return 20;
  } catch (error) {
    console.error('[TowerScheduler] 获取杠杆异常:', error);
    return 20;
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
  // 用于生成 clientOrderId
  timeframe: string;  // 级别: 15m, 1h, 4h
  source: string;     // ICT 种类: OB, FVG, BB 等
}

function calculateOrders(
  towerData: { currentPrice: number; blocks: Array<{ type: string; entry: number; high: number; low: number; source: string; timeframe: string }> },
  management: TowerManagementConfig,
  leverage: number
): TowerOrder[] {
  const { currentPrice, blocks } = towerData;
  const { baseMargin, marginIncrement, towerLayers, bullishStartLayer, bearishStartLayer, minSpacingRatio } = management;

  console.log(`[TowerScheduler] 计算订单: 基础保证金=${baseMargin}, 递增=${marginIncrement}, 杠杆=${leverage}x`);

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

  // 最小距离（启动间距，千分比）
  const { minEntryDistance = 5 } = management;
  const minDistance = currentPrice * (minEntryDistance / 1000);
  // 最小间距（万分之 N）
  const minSpacing = currentPrice * (minSpacingRatio / 10000);

  // 筛选函数：保证所有已选塔块之间间距 >= minSpacing
  const filterWithSpacing = (
    blockList: typeof allBullish,
    startLayer: number,
    count: number
  ) => {
    const result: typeof blockList = [];
    let skipped = 0;

    for (const block of blockList) {
      // 检查与所有已选中块的间距（防止 OTE 优先排序后价格相近的块都被选中）
      const tooClose = result.some(selected => {
        const spacing = Math.abs(block.entry - selected.entry);
        return spacing < minSpacing;
      });

      if (tooClose) {
        console.log(`[TowerScheduler] 跳过 ${block.entry.toFixed(0)} ${block.source} (与已选块间距 < ${minSpacing.toFixed(0)})`);
        continue;
      }

      // 检查 startLayer（跳过前 N-1 层）
      if (skipped < startLayer - 1) {
        skipped++;
        console.log(`[TowerScheduler] 跳过第 ${skipped} 层: ${block.entry.toFixed(0)} ${block.source}`);
        continue;
      }

      result.push(block);

      if (result.length >= count) break;
    }

    return result;
  };

  // 按距离排序函数：近的优先，同距离大级别优先
  const sortByDistance = (
    blocks: typeof allBullish,
    currentPrice: number
  ) => {
    return blocks.sort((a, b) => {
      const distanceA = Math.abs(a.entry - currentPrice);
      const distanceB = Math.abs(b.entry - currentPrice);

      // 按距离排序，近的优先
      if (distanceA !== distanceB) {
        return distanceA - distanceB;
      }
      // 同距离大级别优先
      const tfA = TIMEFRAME_PRIORITY[a.timeframe] || 0;
      const tfB = TIMEFRAME_PRIORITY[b.timeframe] || 0;
      return tfB - tfA;
    });
  };

  // 筛选塔块
  const bullishCandidates = sortByDistance(
    allBullish.filter(b => b.entry < currentPrice && currentPrice - b.entry >= minDistance),
    currentPrice
  );

  const bearishCandidates = sortByDistance(
    allBearish.filter(b => b.entry > currentPrice && b.entry - currentPrice >= minDistance),
    currentPrice
  );

  const selectedBullish = filterWithSpacing(bullishCandidates, bullishStartLayer, towerLayers);
  const selectedBearish = filterWithSpacing(bearishCandidates, bearishStartLayer, towerLayers);

  // 日志：显示选中的塔块
  if (selectedBullish.length > 0) {
    console.log(`[TowerScheduler] 多单塔块: ${selectedBullish.map(b => `${b.entry.toFixed(0)} ${b.source} ${b.timeframe}`).join(' | ')}`);
  }
  if (selectedBearish.length > 0) {
    console.log(`[TowerScheduler] 空单塔块: ${selectedBearish.map(b => `${b.entry.toFixed(0)} ${b.source} ${b.timeframe}`).join(' | ')}`);
  }

  // 下单前按价格排序（离当前价格近的分配小保证金）
  // 多单：价格从高到低（近 → 远）
  // 空单：价格从低到高（近 → 远）
  const orderedBullish = [...selectedBullish].sort((a, b) => b.entry - a.entry);
  const orderedBearish = [...selectedBearish].sort((a, b) => a.entry - b.entry);

  // 转换为订单
  const orders: TowerOrder[] = [];

  for (let i = 0; i < orderedBullish.length; i++) {
    const block = orderedBullish[i];
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
      timeframe: block.timeframe,
      source: block.source,
    });
  }

  for (let i = 0; i < orderedBearish.length; i++) {
    const block = orderedBearish[i];
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
      timeframe: block.timeframe,
      source: block.source,
    });
  }

  return orders;
}

/**
 * 下单（入场单 + 止盈止损单）
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
      // 格式: ict_tower_{级别}_{ICT种类}_{点位}
      // 例如: ict_tower_4h_OB_95000 (21字符,Binance限制<36)
      const priceStr = Math.round(order.price).toString();
      const clientOrderId = `ict_tower_${order.timeframe}_${order.source}_${priceStr}`;

      // 1. 下入场单（限价单）
      const entryParams: Record<string, string | number> = {
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

      const entryQueryString = Object.entries(entryParams)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const entrySignature = generateSignature(entryQueryString, apiConfig.apiSecret);

      const entryResponse = await fetch(`${baseUrl}/fapi/v1/order`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiConfig.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `${entryQueryString}&signature=${entrySignature}`,
      });

      if (!entryResponse.ok) {
        const data = await entryResponse.json() as { msg?: string };
        errors.push(`入场 ${order.side} @ ${order.price}: ${data.msg || entryResponse.status}`);
        continue;
      }

      console.log(`[TowerScheduler] 入场单: ${order.side} @ ${order.price}, 保证金=${order.margin}, 数量=${order.quantity.toFixed(3)}, SL=${order.stopLoss.toFixed(1)}, TP=${order.takeProfit.toFixed(1)}`);

      // 平仓方向
      const closeSide = order.side === 'BUY' ? 'SELL' : 'BUY';

      // 2. 下止损单（STOP_MARKET）- 使用 Algo Order API
      await delay(100);
      const slTimestamp = Date.now();
      const slParams: Record<string, string | number> = {
        algoType: 'CONDITIONAL',
        symbol,
        side: closeSide,
        positionSide: order.positionSide,
        type: 'STOP_MARKET',
        quantity: order.quantity.toFixed(3),
        triggerPrice: order.stopLoss.toFixed(1),
        clientAlgoId: `${clientOrderId}_sl`,
        timestamp: slTimestamp,
      };

      const slQueryString = Object.entries(slParams)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const slSignature = generateSignature(slQueryString, apiConfig.apiSecret);

      const slResponse = await fetch(`${baseUrl}/fapi/v1/algoOrder`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiConfig.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `${slQueryString}&signature=${slSignature}`,
      });

      if (!slResponse.ok) {
        const data = await slResponse.json() as { msg?: string };
        console.warn(`[TowerScheduler] 止损单失败: ${data.msg || slResponse.status}`);
      } else {
        console.log(`[TowerScheduler] 止损单下单成功: ${clientOrderId}_sl`);
      }

      // 止盈单不在此处下，等入场单成交后由 orderMonitor 下单

      success++;

      // 保存待处理订单（用于成交后补下追踪止盈）
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
      await delay(100);
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

/**
 * 监控并修复仓位的止盈止损
 * 检查当前持仓是否有对应的止盈止损单，如果没有则补上
 */
export async function monitorAndRepairPositions(): Promise<void> {
  const activeManagements = getActiveManagements();

  for (const management of activeManagements) {
    try {
      const apiConfig = getBinanceApiConfig(management.userId);
      if (!apiConfig) continue;

      await repairPositionOrders(apiConfig, management.symbol);
    } catch (error) {
      console.error(`[TowerScheduler] 监控仓位失败 ${management.symbol}:`, error);
    }
  }
}

/**
 * 修复单个交易对的仓位止盈止损
 */
async function repairPositionOrders(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string
): Promise<void> {
  const { getPositions, getOpenOrders } = await import('../order/binanceOrderApi');

  // 获取当前持仓
  const positionsResult = await getPositions(apiConfig, symbol);
  if (!positionsResult.success || !positionsResult.positions?.length) {
    return; // 没有持仓，不需要修复
  }

  // 获取当前挂单
  const ordersResult = await getOpenOrders(apiConfig, symbol);
  if (!ordersResult.success) {
    console.error(`[TowerScheduler] 获取挂单失败: ${ordersResult.error}`);
    return;
  }

  const openOrders = ordersResult.orders || [];

  for (const position of positionsResult.positions) {
    // 跳过数量太小的仓位
    if (Math.abs(position.positionAmt) < 0.001) continue;

    const positionSide = position.positionSide as 'LONG' | 'SHORT';
    const quantity = Math.abs(position.positionAmt);
    const entryPrice = position.entryPrice;

    // 检查是否有止损单
    const hasStopLoss = openOrders.some(o =>
      o.positionSide === positionSide &&
      o.type === 'STOP_MARKET'
    );

    // 检查是否有止盈单
    const hasTakeProfit = openOrders.some(o =>
      o.positionSide === positionSide &&
      (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TRAILING_STOP_MARKET')
    );

    // 检查是否有限价平仓单（也算止盈止损）
    const closeSide = positionSide === 'LONG' ? 'SELL' : 'BUY';
    const hasLimitClose = openOrders.some(o =>
      o.positionSide === positionSide &&
      o.side === closeSide &&
      o.type === 'LIMIT'
    );

    // 如果有限价平仓单，认为用户手动设置了，不修复
    if (hasLimitClose) continue;

    if (!hasStopLoss || !hasTakeProfit) {
      console.log(`[TowerScheduler] 发现仓位缺少止盈止损: ${symbol} ${positionSide}, 数量=${quantity}, 入场价=${entryPrice}`);
      console.log(`[TowerScheduler] 当前状态: 止损=${hasStopLoss}, 止盈=${hasTakeProfit}`);

      // 计算止损止盈价格
      const { stopLoss, takeProfit } = calculateSlTpForPosition(entryPrice, positionSide);

      // 补下止损单
      if (!hasStopLoss) {
        await placeRepairOrder(apiConfig, {
          symbol,
          positionSide,
          quantity,
          type: 'STOP_MARKET',
          stopPrice: stopLoss,
        });
      }

      // 补下止盈单
      if (!hasTakeProfit) {
        await placeRepairOrder(apiConfig, {
          symbol,
          positionSide,
          quantity,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: takeProfit,
        });
      }
    }
  }
}

/**
 * 根据入场价和方向计算止损止盈
 */
function calculateSlTpForPosition(
  entryPrice: number,
  positionSide: 'LONG' | 'SHORT'
): { stopLoss: number; takeProfit: number } {
  if (positionSide === 'LONG') {
    // 多单：止损在下方，止盈在上方
    return {
      stopLoss: entryPrice - MAX_SL_DISTANCE,
      takeProfit: entryPrice + MIN_TP_DISTANCE,
    };
  } else {
    // 空单：止损在上方，止盈在下方
    return {
      stopLoss: entryPrice + MAX_SL_DISTANCE,
      takeProfit: entryPrice - MIN_TP_DISTANCE,
    };
  }
}

/**
 * 下修复订单
 * 从 2025-12-09 开始，STOP_MARKET/TAKE_PROFIT_MARKET 必须使用 Algo Order API
 */
async function placeRepairOrder(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  params: {
    symbol: string;
    positionSide: 'LONG' | 'SHORT';
    quantity: number;
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    stopPrice: number;
  }
): Promise<void> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const closeSide = params.positionSide === 'LONG' ? 'SELL' : 'BUY';
  const timestamp = Date.now();
  // 格式: ict_repair_{方向}_{类型}_{点位}
  // 例如: ict_repair_L_SL_94800 (22字符)
  const sideShort = params.positionSide === 'LONG' ? 'L' : 'S';
  const typeShort = params.type === 'STOP_MARKET' ? 'SL' : 'TP';
  const priceStr = Math.round(params.stopPrice).toString();
  const clientOrderId = `ict_repair_${sideShort}_${typeShort}_${priceStr}`;

  // 使用 Algo Order API
  const orderParams: Record<string, string | number> = {
    algoType: 'CONDITIONAL',
    symbol: params.symbol,
    side: closeSide,
    positionSide: params.positionSide,
    type: params.type,
    quantity: params.quantity.toFixed(3),
    triggerPrice: params.stopPrice.toFixed(1),  // Algo API 用 triggerPrice 而非 stopPrice
    clientAlgoId: clientOrderId,  // Algo API 用 clientAlgoId 而非 newClientOrderId
    timestamp,
  };

  const queryString = Object.entries(orderParams)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = generateSignature(queryString, apiConfig.apiSecret);

  try {
    const response = await fetch(`${baseUrl}/fapi/v1/algoOrder`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiConfig.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    if (!response.ok) {
      const data = await response.json() as { msg?: string };
      console.error(`[TowerScheduler] 修复订单失败 ${params.type}: ${data.msg || response.status}`);
    } else {
      console.log(`[TowerScheduler] 修复订单成功: ${params.type} @ ${params.stopPrice}`);
    }
  } catch (error) {
    console.error(`[TowerScheduler] 修复订单异常:`, error);
  }
}
