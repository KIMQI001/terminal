/**
 * 流动性网格托管调度器
 * 后台定时执行流动性网格策略
 */

import {
  getActiveManagements,
  updateRunTime,
  addRecord,
  LiqGridManagementConfig,
  initLiqGridManagementTables,
  ExchangeType,
} from './liqGridManagementStore';
import { getBinanceApiConfig, getAsterApiConfig } from '../order/apiConfigReader';
import { fetchLiquidation, LiquidationLevel } from '../data/liquidationClient';
import { sendDingtalkMarkdownToUser } from '../notification/dingtalk';
import * as exchangeAdapter from '../order/exchangeAdapter';

// 调度器状态
let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

// 日K高低点数据
interface DailyHL {
  high: number;
  low: number;
  pStart: number;  // P区开始 (溢价区)
  dStart: number;  // D区开始 (折扣区)
}

// 交易对精度配置
const SYMBOL_PRECISION: Record<string, { quantity: number; price: number }> = {
  'BTCUSDT': { quantity: 3, price: 1 },
  'ETHUSDT': { quantity: 3, price: 2 },
  'BTCUSDC': { quantity: 3, price: 1 },
  'ETHUSDC': { quantity: 3, price: 2 },
};

function getPrecision(symbol: string) {
  return SYMBOL_PRECISION[symbol] || { quantity: 3, price: 2 };
}

/**
 * 启动流动性网格调度器
 */
export function startLiqGridScheduler(): void {
  if (schedulerInterval) {
    console.log('[LiqGridScheduler] 调度器已在运行');
    return;
  }

  // 初始化数据库表
  initLiqGridManagementTables();

  console.log('[LiqGridScheduler] 启动托管调度器...');

  // 每 30 秒检查一次
  schedulerInterval = setInterval(async () => {
    if (isRunning) return;

    try {
      isRunning = true;
      await checkAndExecute();
    } catch (error) {
      console.error('[LiqGridScheduler] 执行错误:', error);
    } finally {
      isRunning = false;
    }
  }, 30 * 1000);

  console.log('[LiqGridScheduler] 托管调度器已启动');
}

/**
 * 停止调度器
 */
export function stopLiqGridScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[LiqGridScheduler] 托管调度器已停止');
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
      console.log(`[LiqGridScheduler] 执行托管: userId=${management.userId}, symbol=${management.symbol}`);
      await executeLiqGridManagement(management);
    }
  }
}

/**
 * 执行托管任务
 */
async function executeLiqGridManagement(management: LiqGridManagementConfig): Promise<void> {
  const startTime = Date.now();

  try {
    // 获取用户 API 配置（根据交易所类型选择）
    const exchange = management.exchange || 'binance';
    const apiConfig = exchange === 'aster'
      ? getAsterApiConfig(management.userId)
      : getBinanceApiConfig(management.userId);

    if (!apiConfig) {
      console.error(`[LiqGridScheduler] 用户 ${management.userId} 没有 ${exchange} API 配置`);
      addRecord({
        managementId: management.id,
        buyCount: 0,
        sellCount: 0,
        totalMargin: 0,
        success: false,
        skipped: false,
        errorMessage: `没有 ${exchange} API 配置`,
      });
      updateRunTime(management.id);
      return;
    }

    // 统一的 API 配置格式
    const exchangeConfig: exchangeAdapter.ExchangeApiConfig = {
      apiKey: apiConfig.apiKey,
      apiSecret: apiConfig.apiSecret,
      isTestnet: 'isTestnet' in apiConfig ? (apiConfig as { isTestnet?: boolean }).isTestnet : false,
    };

    // 1. 获取当前挂单和持仓
    const ordersResult = await getLiqGridOrders(exchange, exchangeConfig, management.symbol);
    const liqGridOrders = ordersResult.success ? ordersResult.orders || [] : [];
    const liqGridOrderCount = liqGridOrders.length;

    // 获取当前持仓
    const positionsResult = await getPositions(exchange, exchangeConfig, management.symbol);
    const positions = positionsResult.success ? positionsResult.positions || [] : [];
    const longPosition = positions.find(p => p.positionSide === 'LONG' && Math.abs(p.positionAmt) >= 0.001);
    const shortPosition = positions.find(p => p.positionSide === 'SHORT' && Math.abs(p.positionAmt) >= 0.001);

    // 2. 检查是否需要重置挂单
    // 当某方向没有仓位时，检查该方向挂单数量是否需要重置
    let needReset = false;
    const baseQuantity = (management.baseMargin * management.leverage) / 100000; // 估算基础数量

    if (!longPosition && liqGridOrders.length > 0) {
      // 没有多头仓位，检查多单数量是否过大
      const buyOrders = liqGridOrders.filter(o => o.side === 'BUY');
      if (buyOrders.length > 0) {
        const firstBuyQty = parseFloat(buyOrders[0].origQty || '0');
        // 如果第一个多单数量 > 基础数量的 1.5 倍，说明之前有仓位，现在被平了，需要重置
        if (firstBuyQty > baseQuantity * 1.5) {
          console.log(`[LiqGridScheduler] 检测到多头仓位已清零，但挂单数量过大(${firstBuyQty.toFixed(4)} > ${(baseQuantity * 1.5).toFixed(4)})，需要重置`);
          needReset = true;
        }
      }
    }

    if (!shortPosition && liqGridOrders.length > 0) {
      // 没有空头仓位，检查空单数量是否过大
      const sellOrders = liqGridOrders.filter(o => o.side === 'SELL');
      if (sellOrders.length > 0) {
        const firstSellQty = parseFloat(sellOrders[0].origQty || '0');
        if (firstSellQty > baseQuantity * 1.5) {
          console.log(`[LiqGridScheduler] 检测到空头仓位已清零，但挂单数量过大(${firstSellQty.toFixed(4)} > ${(baseQuantity * 1.5).toFixed(4)})，需要重置`);
          needReset = true;
        }
      }
    }

    // 3. 决定是否更新
    if (liqGridOrderCount >= 8 && !needReset) {
      console.log(`[LiqGridScheduler] 挂单数量充足(${liqGridOrderCount}个)，跳过更新`);
      addRecord({
        managementId: management.id,
        buyCount: 0,
        sellCount: 0,
        totalMargin: 0,
        success: true,
        skipped: true,
        errorMessage: undefined,
      });
      updateRunTime(management.id);
      return;
    }

    console.log(`[LiqGridScheduler] ${needReset ? '仓位已清零需要重置' : `挂单数量不足(${liqGridOrderCount}个)`}，开始更新...`);

    // 2. 获取清算数据
    const baseCoin = management.symbol.replace('USDC', '').replace('USDT', '');
    const liqData = await fetchLiquidation(baseCoin, '1d');

    if (!liqData || (liqData.longPeaks.length === 0 && liqData.shortPeaks.length === 0)) {
      console.error(`[LiqGridScheduler] 获取清算数据失败: ${management.symbol}`);
      addRecord({
        managementId: management.id,
        buyCount: 0,
        sellCount: 0,
        totalMargin: 0,
        success: false,
        skipped: false,
        errorMessage: '获取清算数据失败',
      });
      updateRunTime(management.id);
      return;
    }

    // 2.5 获取日K P/D 区域数据
    const dailyHL = await getDailyHL(management.symbol, liqData.currentPrice);
    if (dailyHL) {
      console.log(`[LiqGridScheduler] P/D区域: H=${dailyHL.high.toFixed(0)} P=${dailyHL.pStart.toFixed(0)} D=${dailyHL.dStart.toFixed(0)} L=${dailyHL.low.toFixed(0)}`);
    }

    // 3. 取消现有 liq_grid 订单
    const cancelResult = await cancelLiqGridOrders(exchange, exchangeConfig, management.symbol);
    if (!cancelResult.success) {
      console.error(`[LiqGridScheduler] 取消订单失败: ${cancelResult.error}`);
    }

    // 等待订单取消完成
    await delay(500);

    // 4. 设置杠杆
    await setLeverage(exchange, exchangeConfig, management.symbol, management.leverage);

    // 5. 使用前面获取的持仓信息计算起点保证金
    const longNotional = longPosition?.notional || 0;
    const shortNotional = shortPosition?.notional || 0;

    // 6. 计算网格订单（传入持仓价值，用于计算起点保证金）
    let orders = calculateGridOrders(liqData, management, longNotional, shortNotional);

    // 7. 根据持仓过滤订单位置
    // 多单必须低于所有持仓成本（避免在持仓成本附近开多）
    // 空单必须高于所有持仓成本（避免在持仓成本附近开空）
    const positionCosts: number[] = [];
    if (longPosition) positionCosts.push(longPosition.entryPrice);
    if (shortPosition) positionCosts.push(shortPosition.entryPrice);

    if (positionCosts.length > 0) {
      const minCost = Math.min(...positionCosts);
      const maxCost = Math.max(...positionCosts);

      // 多单必须 < 所有持仓成本的最低价
      const buyBeforeCount = orders.filter(o => o.side === 'BUY').length;
      orders = orders.filter(o => o.side !== 'BUY' || o.entryPrice < minCost);
      const buyAfterCount = orders.filter(o => o.side === 'BUY').length;
      if (buyBeforeCount !== buyAfterCount) {
        console.log(`[LiqGridScheduler] 持仓最低成本 ${minCost.toFixed(2)}，过滤掉 ${buyBeforeCount - buyAfterCount} 个多单`);
      }

      // 空单必须 > 所有持仓成本的最高价
      const sellBeforeCount = orders.filter(o => o.side === 'SELL').length;
      orders = orders.filter(o => o.side !== 'SELL' || o.entryPrice > maxCost);
      const sellAfterCount = orders.filter(o => o.side === 'SELL').length;
      if (sellBeforeCount !== sellAfterCount) {
        console.log(`[LiqGridScheduler] 持仓最高成本 ${maxCost.toFixed(2)}，过滤掉 ${sellBeforeCount - sellAfterCount} 个空单`);
      }
    }

    // 8. P/D 区域过滤：多单必须在 D 以下，空单必须在 P 以上
    if (dailyHL) {
      const buyBeforePD = orders.filter(o => o.side === 'BUY').length;
      const sellBeforePD = orders.filter(o => o.side === 'SELL').length;

      // 多单入场价必须 <= D（折扣区）
      orders = orders.filter(o => o.side !== 'BUY' || o.entryPrice <= dailyHL.dStart);
      // 空单入场价必须 >= P（溢价区）
      orders = orders.filter(o => o.side !== 'SELL' || o.entryPrice >= dailyHL.pStart);

      const buyAfterPD = orders.filter(o => o.side === 'BUY').length;
      const sellAfterPD = orders.filter(o => o.side === 'SELL').length;

      if (buyBeforePD !== buyAfterPD || sellBeforePD !== sellAfterPD) {
        console.log(`[LiqGridScheduler] P/D过滤: 多单 ${buyBeforePD} -> ${buyAfterPD} (需 <= D=${dailyHL.dStart.toFixed(0)}), 空单 ${sellBeforePD} -> ${sellAfterPD} (需 >= P=${dailyHL.pStart.toFixed(0)})`);
      }
    }

    // 9. 过滤后重新计算保证金（按过滤后的索引，从 baseMargin 开始）
    {
      const { baseMargin, marginPerLevel, leverage } = management;

      // 计算起点保证金（与 calculateGridOrders 逻辑一致）
      const longBaseMargin = longNotional > 0
        ? Math.max(baseMargin, Math.round(longNotional / leverage / 5) + marginPerLevel)
        : baseMargin;
      const shortBaseMargin = shortNotional > 0
        ? Math.max(baseMargin, Math.round(shortNotional / leverage / 5) + marginPerLevel)
        : baseMargin;

      // 多单：按价格从高到低排序后重算（离当前价近的保证金小）
      const buyOrders = orders.filter(o => o.side === 'BUY');
      buyOrders.sort((a, b) => b.entryPrice - a.entryPrice);
      for (let i = 0; i < buyOrders.length; i++) {
        const margin = longBaseMargin + marginPerLevel * i;
        buyOrders[i].margin = margin;
        buyOrders[i].quantity = (margin * leverage) / buyOrders[i].entryPrice;
      }

      // 空单：按价格从低到高排序后重算（离当前价近的保证金小）
      const sellOrders = orders.filter(o => o.side === 'SELL');
      sellOrders.sort((a, b) => a.entryPrice - b.entryPrice);
      for (let i = 0; i < sellOrders.length; i++) {
        const margin = shortBaseMargin + marginPerLevel * i;
        sellOrders[i].margin = margin;
        sellOrders[i].quantity = (margin * leverage) / sellOrders[i].entryPrice;
      }

      orders = [...buyOrders, ...sellOrders];
    }

    // 10. 如果设置了 maxQuantity，限制每个订单的数量
    if (management.maxQuantity > 0) {
      let clippedCount = 0;
      for (const order of orders) {
        if (order.quantity > management.maxQuantity) {
          order.quantity = management.maxQuantity;
          clippedCount++;
        }
      }
      if (clippedCount > 0) {
        console.log(`[LiqGridScheduler] 限制数量: ${clippedCount} 个订单被裁剪到 maxQty=${management.maxQuantity}`);
      }
    }

    if (orders.length === 0) {
      console.log('[LiqGridScheduler] 没有符合条件的订单（可能被持仓或P/D区域过滤）');
      addRecord({
        managementId: management.id,
        buyCount: 0,
        sellCount: 0,
        totalMargin: 0,
        success: true,
        skipped: true,
        errorMessage: '没有符合条件的订单（P/D过滤）',
      });
      updateRunTime(management.id);
      return;
    }

    // 8. 下单
    const result = await placeOrders(exchange, exchangeConfig, management.symbol, orders);

    // 7. 记录结果
    const buyCount = orders.filter(o => o.side === 'BUY').length;
    const sellCount = orders.filter(o => o.side === 'SELL').length;
    const totalMargin = orders.reduce((sum, o) => sum + o.margin, 0);

    addRecord({
      managementId: management.id,
      buyCount,
      sellCount,
      totalMargin,
      success: result.errors.length === 0,
      skipped: false,
      errorMessage: result.errors.length > 0 ? result.errors.join('; ') : undefined,
    });

    // 更新执行时间
    updateRunTime(management.id);

    const duration = Date.now() - startTime;
    console.log(`[LiqGridScheduler] 执行完成: ${orders.length}单, 总保证金=${totalMargin} USDT, ${result.errors.length}错误, 耗时${duration}ms`);

    // 发送钉钉通知（如果有错误）
    if (result.errors.length > 0) {
      await sendDingtalkMarkdownToUser(
        management.userId,
        '流动性网格告警',
        `### 流动性网格执行有错误\n\n` +
        `- **交易对**: ${management.symbol}\n` +
        `- **下单数**: ${orders.length}\n` +
        `- **错误数**: ${result.errors.length}\n` +
        `- **错误**: ${result.errors.slice(0, 3).join(', ')}`
      );
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[LiqGridScheduler] 执行异常:`, error);

    addRecord({
      managementId: management.id,
      buyCount: 0,
      sellCount: 0,
      totalMargin: 0,
      success: false,
      skipped: false,
      errorMessage: errorMsg,
    });

    updateRunTime(management.id);
  }
}

// 网格订单
interface GridOrder {
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  tpPrice: number;
  quantity: number;
  margin: number;
}

/**
 * 计算网格订单
 * @param liqData 清算数据
 * @param management 配置
 * @param longNotional 多头持仓价值（用于计算新多单起点保证金）
 * @param shortNotional 空头持仓价值（用于计算新空单起点保证金）
 */
function calculateGridOrders(
  liqData: { longPeaks: LiquidationLevel[]; shortPeaks: LiquidationLevel[]; currentPrice: number },
  management: LiqGridManagementConfig,
  longNotional: number = 0,
  shortNotional: number = 0
): GridOrder[] {
  const { longPeaks, shortPeaks } = liqData;
  const { baseMargin, marginPerLevel, leverage } = management;

  const orders: GridOrder[] = [];

  // 根据持仓计算新订单的起点保证金
  // 公式：Max(baseMargin, 持仓价值/杠杆/5 + marginPerLevel)
  // 确保起点保证金不低于基础设定值，避免下单金额过小
  const longBaseMargin = longNotional > 0
    ? Math.max(baseMargin, Math.round(longNotional / leverage / 5) + marginPerLevel)
    : baseMargin;
  const shortBaseMargin = shortNotional > 0
    ? Math.max(baseMargin, Math.round(shortNotional / leverage / 5) + marginPerLevel)
    : baseMargin;

  if (longNotional > 0) {
    console.log(`[LiqGridScheduler] 多头持仓价值 ${longNotional.toFixed(0)} USDT，新多单起点保证金: ${longBaseMargin} USDT`);
  }
  if (shortNotional > 0) {
    console.log(`[LiqGridScheduler] 空头持仓价值 ${shortNotional.toFixed(0)} USDT，新空单起点保证金: ${shortBaseMargin} USDT`);
  }

  // 多头清算峰 → 开多单（抄底）→ 止盈设在空头清算峰（最近的）
  const lowestShortPeak = shortPeaks.length > 0
    ? shortPeaks.reduce((min, p) => (p.price < min.price ? p : min), shortPeaks[0])
    : null;

  // 多单：按价格从高到低排序（离当前价近的先）
  const sortedLongPeaks = [...longPeaks].sort((a, b) => b.price - a.price);
  for (let i = 0; i < sortedLongPeaks.length; i++) {
    const peak = sortedLongPeaks[i];
    const tpPrice = lowestShortPeak?.price || peak.price * 1.02;
    const margin = longBaseMargin + marginPerLevel * i;
    const quantity = (margin * leverage) / peak.price;

    orders.push({
      side: 'BUY',
      positionSide: 'LONG',
      entryPrice: peak.price,
      tpPrice,
      quantity,
      margin,
    });
  }

  // 空头清算峰 → 开空单（摸顶）→ 止盈设在多头清算峰（最近的）
  const highestLongPeak = longPeaks.length > 0
    ? longPeaks.reduce((max, p) => (p.price > max.price ? p : max), longPeaks[0])
    : null;

  // 空单：按价格从低到高排序（离当前价近的先）
  const sortedShortPeaks = [...shortPeaks].sort((a, b) => a.price - b.price);
  for (let i = 0; i < sortedShortPeaks.length; i++) {
    const peak = sortedShortPeaks[i];
    const tpPrice = highestLongPeak?.price || peak.price * 0.98;
    const margin = shortBaseMargin + marginPerLevel * i;
    const quantity = (margin * leverage) / peak.price;

    orders.push({
      side: 'SELL',
      positionSide: 'SHORT',
      entryPrice: peak.price,
      tpPrice,
      quantity,
      margin,
    });
  }

  console.log(`[LiqGridScheduler] 计算订单: 基础保证金=${baseMargin}, 递增=${marginPerLevel}, 杠杆=${leverage}x, 多单=${sortedLongPeaks.length}, 空单=${sortedShortPeaks.length}`);

  return orders;
}

/**
 * 下单（使用统一适配器）
 */
async function placeOrders(
  exchange: ExchangeType,
  config: exchangeAdapter.ExchangeApiConfig,
  symbol: string,
  orders: GridOrder[]
): Promise<{ success: number; errors: string[] }> {
  let successCount = 0;
  const errors: string[] = [];
  const precision = getPrecision(symbol);

  for (const order of orders) {
    try {
      const timestamp = Date.now();
      const priceStr = order.entryPrice.toFixed(precision.price).replace('.', '');
      const clientOrderId = `liq_grid_${order.side.toLowerCase()}_${priceStr}_${timestamp}`;

      // 下限价单
      const result = await exchangeAdapter.placeLimitOrder(exchange, config, {
        symbol,
        side: order.side,
        positionSide: order.positionSide,
        quantity: order.quantity,
        price: order.entryPrice,
        clientOrderId,
      });

      if (!result.success) {
        errors.push(`${order.side} @ ${order.entryPrice}: ${result.error || 'Unknown error'}`);
        continue;
      }

      console.log(`[LiqGridScheduler] 入场单: ${order.side} @ ${order.entryPrice}, 保证金=${order.margin}, 数量=${order.quantity.toFixed(precision.quantity)}, TP=${order.tpPrice.toFixed(precision.price)}`);

      // 保存待处理订单（用于成交后下止盈单）
      await savePendingOrder({
        clientOrderId,
        symbol,
        exchange,
        side: order.side,
        positionSide: order.positionSide,
        quantity: order.quantity,
        entryPrice: order.entryPrice,
        stopLoss: 0,  // 无止损
        takeProfit: order.tpPrice,
      });

      successCount++;

      // 延迟避免请求过快
      await delay(100);
    } catch (error) {
      errors.push(`${order.side} @ ${order.entryPrice}: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  return { success: successCount, errors };
}

/**
 * 保存待处理订单
 */
async function savePendingOrder(params: {
  clientOrderId: string;
  symbol: string;
  exchange: ExchangeType;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}): Promise<void> {
  const { addPendingOrder } = await import('../order/pendingOrderStore');
  addPendingOrder(params);
}

/**
 * 获取持仓（使用统一适配器）
 */
async function getPositions(
  exchange: ExchangeType,
  config: exchangeAdapter.ExchangeApiConfig,
  symbol: string
): Promise<{ success: boolean; positions?: Array<{ positionSide: string; positionAmt: number; entryPrice: number; notional: number }> }> {
  const result = await exchangeAdapter.getPositions(exchange, config, symbol);
  if (!result.success || !result.positions) {
    return { success: false };
  }
  return {
    success: true,
    positions: result.positions.map(p => ({
      positionSide: p.positionSide,
      positionAmt: p.positionAmt,
      entryPrice: p.entryPrice,
      notional: p.notional,
    })),
  };
}

/**
 * 获取 liq_grid 挂单（使用统一适配器）
 */
async function getLiqGridOrders(
  exchange: ExchangeType,
  config: exchangeAdapter.ExchangeApiConfig,
  symbol: string
): Promise<{ success: boolean; orders?: Array<{ orderId: number; clientOrderId: string; side: string; origQty: string }> }> {
  const result = await exchangeAdapter.getOpenOrders(exchange, config, symbol);
  if (!result.success || !result.orders) {
    return { success: false };
  }
  // 过滤出 liq_grid 订单
  const liqGridOrders = result.orders
    .filter(o => o.clientOrderId?.startsWith('liq_grid'))
    .map(o => ({
      orderId: o.orderId,
      clientOrderId: o.clientOrderId,
      side: o.side,
      origQty: o.origQty,
    }));
  return { success: true, orders: liqGridOrders };
}

/**
 * 取消所有 liq_grid 订单（使用统一适配器）
 */
async function cancelLiqGridOrders(
  exchange: ExchangeType,
  config: exchangeAdapter.ExchangeApiConfig,
  symbol: string
): Promise<{ success: boolean; error?: string }> {
  const result = await exchangeAdapter.cancelOrdersByPrefix(exchange, config, symbol, 'liq_grid');
  if (result.canceledCount > 0) {
    console.log(`[LiqGridScheduler] 取消了 ${result.canceledCount} 个订单`);
  }
  return { success: result.success, error: result.error };
}

/**
 * 设置杠杆（使用统一适配器）
 */
async function setLeverage(
  exchange: ExchangeType,
  config: exchangeAdapter.ExchangeApiConfig,
  symbol: string,
  leverage: number
): Promise<boolean> {
  const result = await exchangeAdapter.setLeverage(exchange, config, symbol, leverage);
  if (result.success) {
    console.log(`[LiqGridScheduler] 杠杆设置成功: ${symbol} ${leverage}x`);
  }
  return result.success;
}

/**
 * 延迟
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取日K前高前低（用于 P/D 区域计算）
 */
async function getDailyHL(symbol: string, currentPrice: number): Promise<DailyHL | null> {
  try {
    const response = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=100`
    );

    if (!response.ok) {
      console.error('[LiqGridScheduler] 获取日K数据失败');
      return null;
    }

    const klines = await response.json() as Array<[number, string, string, string, string, ...unknown[]]>;
    if (klines.length < 2) return null;

    // 当日K线
    const todayCandle = {
      high: parseFloat(klines[klines.length - 1][2]),
      low: parseFloat(klines[klines.length - 1][3]),
    };

    // 从倒数第二根向左扫描，找到包含当前价格的K线
    for (let i = klines.length - 2; i >= 0; i--) {
      const high = parseFloat(klines[i][2]);
      const low = parseFloat(klines[i][3]);

      if (currentPrice >= low && currentPrice <= high) {
        const finalHigh = Math.max(high, todayCandle.high);
        const finalLow = Math.min(low, todayCandle.low);
        const range = finalHigh - finalLow;
        const quarterRange = range / 4;

        return {
          high: finalHigh,
          low: finalLow,
          pStart: finalHigh - quarterRange,  // P区开始
          dStart: finalLow + quarterRange,   // D区开始
        };
      }
    }

    return null;
  } catch (error) {
    console.error('[LiqGridScheduler] 获取日K异常:', error);
    return null;
  }
}

/**
 * 检查调度器是否运行
 */
export function isSchedulerRunning(): boolean {
  return schedulerInterval !== null;
}
