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
  ExchangeType,
} from './towerManagementStore';
import { getBinanceApiConfig, getAsterApiConfig } from '../order/apiConfigReader';
import { fetchTowerBlocks } from './towerBlocksFetcher';
import { sendDingtalkMarkdownToUser } from '../notification/dingtalk';
import * as exchangeAdapter from '../order/exchangeAdapter';

// 调度器状态
let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

// 止损止盈参数
const MAX_SL_DISTANCE = 200;
const MIN_TP_RATIO = 0.025;  // 止盈最小 2.5%

// 日K前高前低接口
interface DailyHL {
  high: number;
  low: number;
  pStart: number;  // P区开始 (溢价区)
  dStart: number;  // D区开始 (折扣区)
}

// Coinglass 清算数据接口
interface CGLiqData {
  longTop: Array<{ price: number; amount: number }>;
  shortTop: Array<{ price: number; amount: number }>;
}

// Coinglass 服务地址
const COINGLASS_SERVICE_URL = process.env.COINGLASS_SERVICE_URL || 'http://127.0.0.1:3004';

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

// 每日8点检查（UTC+8）
let lastDailyCheckDate: string | null = null;
const DAILY_CHECK_HOUR = 8;  // UTC+8 早上8点
const CG_SPREAD_THRESHOLD = 2000;  // CG top1 多空价差阈值

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

  // 每日 8 点检查 CG 多空价差（UTC+8）
  await checkDailyCGSpread(activeManagements);
}

/**
 * 每日 8 点检查 CG top1 多空价差
 * 如果价差 > 2000 点，取消所有挂单并更新
 */
async function checkDailyCGSpread(activeManagements: TowerManagementConfig[]): Promise<void> {
  // 计算 UTC+8 时间
  const now = new Date();
  const utc8Hour = (now.getUTCHours() + 8) % 24;
  const utc8Date = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().split('T')[0];

  // 检查是否是 8 点且今天还没检查过
  if (utc8Hour !== DAILY_CHECK_HOUR || lastDailyCheckDate === utc8Date) {
    return;
  }

  console.log(`[TowerScheduler] 每日8点检查开始 (UTC+8: ${utc8Date} ${utc8Hour}:00)`);
  lastDailyCheckDate = utc8Date;

  for (const management of activeManagements) {
    try {
      // 获取 CG 数据
      const cgData = await fetchCGLiqData(management.symbol);
      if (!cgData || cgData.longTop.length === 0 || cgData.shortTop.length === 0) {
        console.log(`[TowerScheduler] ${management.symbol} 无CG数据，跳过每日检查`);
        continue;
      }

      // 计算 top1 多空价差
      const longTop1 = cgData.longTop[0].price;
      const shortTop1 = cgData.shortTop[0].price;
      const spread = Math.abs(shortTop1 - longTop1);

      console.log(`[TowerScheduler] ${management.symbol} CG价差: 空top1=${shortTop1}, 多top1=${longTop1}, 价差=${spread.toFixed(0)}`);

      if (spread > CG_SPREAD_THRESHOLD) {
        console.log(`[TowerScheduler] ${management.symbol} CG价差 ${spread.toFixed(0)} > ${CG_SPREAD_THRESHOLD}，触发更新`);

        // 获取 API 配置
        const exchange = management.exchange || 'binance';
        const apiConfig = exchange === 'aster'
          ? getAsterApiConfig(management.userId)
          : getBinanceApiConfig(management.userId);

        if (!apiConfig) {
          console.error(`[TowerScheduler] 用户 ${management.userId} 没有 ${exchange} API 配置`);
          continue;
        }

        const exchangeConfig: exchangeAdapter.ExchangeApiConfig = {
          apiKey: apiConfig.apiKey,
          apiSecret: apiConfig.apiSecret,
          isTestnet: 'isTestnet' in apiConfig ? (apiConfig as { isTestnet?: boolean }).isTestnet : false,
        };

        // 检查是否有持仓，有持仓则跳过
        const positionsResult = await exchangeAdapter.getPositions(exchange, exchangeConfig, management.symbol);
        if (positionsResult.success && positionsResult.positions) {
          const positions = positionsResult.positions.filter(p => Math.abs(p.positionAmt) >= 0.001);
          if (positions.length > 0) {
            console.log(`[TowerScheduler] ${management.symbol} 有持仓，跳过每日更新`);
            continue;
          }
        }

        // 取消所有守塔订单并重新执行托管
        await cancelAllTowerOrders(exchange, exchangeConfig, management.symbol);
        await executeTowerManagement(management);
      }
    } catch (error) {
      console.error(`[TowerScheduler] ${management.symbol} 每日检查异常:`, error);
    }
  }

  console.log('[TowerScheduler] 每日8点检查完成');
}

/**
 * 执行托管任务
 */
async function executeTowerManagement(management: TowerManagementConfig): Promise<void> {
  const startTime = Date.now();

  try {
    // 获取用户 API 配置（根据交易所类型选择）
    const exchange = management.exchange || 'binance';
    const apiConfig = exchange === 'aster'
      ? getAsterApiConfig(management.userId)
      : getBinanceApiConfig(management.userId);

    if (!apiConfig) {
      console.error(`[TowerScheduler] 用户 ${management.userId} 没有 ${exchange} API 配置`);
      addRecord({
        managementId: management.id,
        bullishCount: 0,
        bearishCount: 0,
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

    // 1. 检查是否有持仓（有持仓时跳过，避免取消止盈止损单）
    const positionsResult = await exchangeAdapter.getPositions(exchange, exchangeConfig, management.symbol);
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
    const orderCheck = await checkOrdersCount(exchange, exchangeConfig, management.symbol, management.towerLayers);
    if (orderCheck.sufficient || orderCheck.hasNearOrder) {
      // 订单充足或有近距离订单时，检查是否有更优的 CG 首单机会
      const cgOpportunity = await checkCGUpdateOpportunity(exchange, exchangeConfig, management.symbol);
      console.log(`[TowerScheduler] CG检查结果: shouldUpdate=${cgOpportunity.shouldUpdate}, reason=${cgOpportunity.reason || '无'}`);

      if (!cgOpportunity.shouldUpdate) {
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

      // 有 CG 机会，继续更新
      console.log(`[TowerScheduler] CG机会触发更新: ${cgOpportunity.reason}`);
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
    const cancelResult = await cancelAllTowerOrders(exchange, exchangeConfig, management.symbol);
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
    const leverage = await getLeverage(exchange, exchangeConfig, management.symbol);

    // 6. 获取日K前高前低（用于区域过滤）
    const dailyHL = await getDailyHL(management.symbol, towerData.currentPrice);

    // 7. 获取 Coinglass 清算数据
    const cgData = await fetchCGLiqData(management.symbol);

    // 8. 计算要下的订单
    const orders = calculateOrders(towerData, management, leverage, dailyHL, cgData);
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

    // 9. 下单
    const result = await placeOrders(exchange, exchangeConfig, management.symbol, orders, {
      activationRatio: management.trailingActivationRatio,
      callbackRate: management.trailingCallbackRate,
    });

    // 10. 记录结果
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
      await sendDingtalkMarkdownToUser(
        management.userId,
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

// CG 首单更新参数
const CG_TOP_RATIO_THRESHOLD = 1.2;  // top1 需要比 top2 大 20%
const CG_BETTER_THRESHOLD = 200;     // CG 首单更优阈值（点）

/**
 * 检查订单数量
 */
async function checkOrdersCount(
  exchange: ExchangeType,
  exchangeConfig: exchangeAdapter.ExchangeApiConfig,
  symbol: string,
  requiredLayers: number
): Promise<{ bullish: number; bearish: number; sufficient: boolean; hasNearOrder: boolean }> {
  try {
    // 获取挂单
    const ordersResult = await exchangeAdapter.getOpenOrders(exchange, exchangeConfig, symbol);
    if (!ordersResult.success || !ordersResult.orders) {
      return { bullish: 0, bearish: 0, sufficient: false, hasNearOrder: false };
    }

    // 获取当前价格
    const baseUrl = exchange === 'aster'
      ? 'https://fapi.asterdex.com'
      : (exchangeConfig.isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com');
    const priceResponse = await fetch(`${baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`);
    let currentPrice = 0;
    if (priceResponse.ok) {
      const priceData = await priceResponse.json() as { price: string };
      currentPrice = parseFloat(priceData.price);
    }

    // 只统计 ict_tower 前缀的限价单
    const towerOrders = ordersResult.orders.filter(
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
        return Math.abs(o.price - currentPrice) <= nearDistance;
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
 * 检查 CG 首单更新机会
 * 条件：
 * 1. 新首单价格更优（多单更低，空单更高）
 * 2. top1 爆仓量比 top2 大 20% 以上
 * 3. 当前价格 1% 距离内没有订单
 */
async function checkCGUpdateOpportunity(
  exchange: ExchangeType,
  exchangeConfig: exchangeAdapter.ExchangeApiConfig,
  symbol: string
): Promise<{ shouldUpdate: boolean; reason?: string }> {
  try {
    // 1. 获取当前价格
    const baseUrl = exchange === 'aster'
      ? 'https://fapi.asterdex.com'
      : (exchangeConfig.isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com');
    const priceResponse = await fetch(`${baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`);
    if (!priceResponse.ok) return { shouldUpdate: false };
    const priceData = await priceResponse.json() as { price: string };
    const currentPrice = parseFloat(priceData.price);

    // 2. 获取当前挂单
    const ordersResult = await exchangeAdapter.getOpenOrders(exchange, exchangeConfig, symbol);
    if (!ordersResult.success || !ordersResult.orders) {
      return { shouldUpdate: false };
    }

    const towerOrders = ordersResult.orders.filter(
      o => o.clientOrderId?.startsWith('ict_tower') && o.type === 'LIMIT'
    );

    // 3. 检查 1% 距离内是否有订单（有则不更新）
    const nearDistance = currentPrice * NEAR_PRICE_RATIO;
    const hasNearOrder = towerOrders.some(o => Math.abs(o.price - currentPrice) <= nearDistance);
    if (hasNearOrder) {
      return { shouldUpdate: false, reason: '1%距离内有订单' };
    }

    // 4. 获取 CG 数据
    const cgData = await fetchCGLiqData(symbol);
    if (!cgData) {
      return { shouldUpdate: false, reason: '无CG数据' };
    }

    // 5. 获取日K数据
    const dailyHL = await getDailyHL(symbol, currentPrice);
    if (!dailyHL) {
      return { shouldUpdate: false, reason: '无日K数据' };
    }

    // 5.5 检查是否有 CG 首单挂着，并获取其入场价
    const cgLongOrder = towerOrders.find(o => o.side === 'BUY' && o.clientOrderId?.includes('_CG_'));
    const cgShortOrder = towerOrders.find(o => o.side === 'SELL' && o.clientOrderId?.includes('_CG_'));
    const hasCGLong = !!cgLongOrder;
    const hasCGShort = !!cgShortOrder;
    console.log(`[TowerScheduler] CG首单状态: 多=${hasCGLong}${hasCGLong ? `@${cgLongOrder!.price.toFixed(0)}` : ''}, 空=${hasCGShort}${hasCGShort ? `@${cgShortOrder!.price.toFixed(0)}` : ''}, D=${dailyHL.dStart.toFixed(0)}, P=${dailyHL.pStart.toFixed(0)}`);

    // 5.6 检查 CG 多单机会（无论是否已有）
    if (cgData.longTop.length > 0) {
      const longBelowD = cgData.longTop.filter(l => l.price < dailyHL.dStart);
      if (longBelowD.length > 0) {
        const maxLong = longBelowD.reduce((max, l) => l.amount > max.amount ? l : max, longBelowD[0]);
        const offset = Math.max(200, maxLong.price * 0.002);
        const newEntry = maxLong.price + offset;

        if (newEntry <= dailyHL.dStart) {
          if (!hasCGLong) {
            // 没有 CG 多单，新建
            console.log(`[TowerScheduler] CG多单检查: 清算价=${maxLong.price}, 入场=${newEntry.toFixed(0)}, D=${dailyHL.dStart.toFixed(0)}, 满足`);
            return { shouldUpdate: true, reason: `CG多单可用: 入场=${newEntry.toFixed(0)} <= D` };
          } else {
            // 已有 CG 多单，检查是否更优（新入场价更低）
            const existingEntry = cgLongOrder!.price;
            const improvement = existingEntry - newEntry;
            console.log(`[TowerScheduler] CG多单检查: 新入场=${newEntry.toFixed(0)}, 现有=${existingEntry.toFixed(0)}, 改善=${improvement.toFixed(0)}点`);
            if (improvement >= CG_BETTER_THRESHOLD) {
              return { shouldUpdate: true, reason: `CG多单更优: ${newEntry.toFixed(0)} 比现有 ${existingEntry.toFixed(0)} 低 ${improvement.toFixed(0)}点` };
            }
          }
        } else {
          console.log(`[TowerScheduler] CG多单检查: 入场=${newEntry.toFixed(0)} > D=${dailyHL.dStart.toFixed(0)}, 不满足`);
        }
      } else {
        console.log(`[TowerScheduler] CG多单检查: 无清算价 < D`);
      }
    }

    // 5.7 检查 CG 空单机会（无论是否已有）
    if (cgData.shortTop.length > 0) {
      const shortAboveP = cgData.shortTop.filter(s => s.price > dailyHL.pStart);
      if (shortAboveP.length > 0) {
        const maxShort = shortAboveP.reduce((max, s) => s.amount > max.amount ? s : max, shortAboveP[0]);
        const offset = Math.max(200, maxShort.price * 0.002);
        const newEntry = maxShort.price - offset;

        if (newEntry >= dailyHL.pStart) {
          if (!hasCGShort) {
            // 没有 CG 空单，新建
            console.log(`[TowerScheduler] CG空单检查: 清算价=${maxShort.price}, 入场=${newEntry.toFixed(0)}, P=${dailyHL.pStart.toFixed(0)}, 满足`);
            return { shouldUpdate: true, reason: `CG空单可用: 入场=${newEntry.toFixed(0)} >= P` };
          } else {
            // 已有 CG 空单，检查是否更优（新入场价更高）
            const existingEntry = cgShortOrder!.price;
            const improvement = newEntry - existingEntry;
            console.log(`[TowerScheduler] CG空单检查: 新入场=${newEntry.toFixed(0)}, 现有=${existingEntry.toFixed(0)}, 改善=${improvement.toFixed(0)}点`);
            if (improvement >= CG_BETTER_THRESHOLD) {
              return { shouldUpdate: true, reason: `CG空单更优: ${newEntry.toFixed(0)} 比现有 ${existingEntry.toFixed(0)} 高 ${improvement.toFixed(0)}点` };
            }
          }
        } else {
          console.log(`[TowerScheduler] CG空单检查: 入场=${newEntry.toFixed(0)} < P=${dailyHL.pStart.toFixed(0)}, 不满足`);
        }
      } else {
        console.log(`[TowerScheduler] CG空单检查: 无清算价 > P`);
      }
    }

    // 6. 检查多单机会
    const longBelowD = cgData.longTop.filter(l => l.price < dailyHL.dStart);
    if (longBelowD.length >= 2) {
      // 按爆仓量排序
      const sorted = [...longBelowD].sort((a, b) => b.amount - a.amount);
      const top1 = sorted[0];
      const top2 = sorted[1];

      // top1 比 top2 大 20% 以上
      if (top1.amount >= top2.amount * CG_TOP_RATIO_THRESHOLD) {
        const newEntry = top1.price + 200;
        // 检查是否比现有多单更优（入场价更低）
        const existingLongs = towerOrders.filter(o => o.side === 'BUY');
        const lowestLong = existingLongs.length > 0
          ? Math.min(...existingLongs.map(o => o.price))
          : Infinity;

        if (newEntry < lowestLong) {
          console.log(`[TowerScheduler] CG多单机会: 新入场${newEntry.toFixed(0)} < 现有最低${lowestLong.toFixed(0)}, top1=${top1.amount.toFixed(0)}M > top2=${top2.amount.toFixed(0)}M`);
          return { shouldUpdate: true, reason: `CG多单更优: ${newEntry.toFixed(0)} < ${lowestLong.toFixed(0)}` };
        }
      }
    }

    // 7. 检查空单机会
    const shortAboveP = cgData.shortTop.filter(s => s.price > dailyHL.pStart);
    if (shortAboveP.length >= 2) {
      const sorted = [...shortAboveP].sort((a, b) => b.amount - a.amount);
      const top1 = sorted[0];
      const top2 = sorted[1];

      if (top1.amount >= top2.amount * CG_TOP_RATIO_THRESHOLD) {
        const newEntry = top1.price - 200;
        const existingShorts = towerOrders.filter(o => o.side === 'SELL');
        const highestShort = existingShorts.length > 0
          ? Math.max(...existingShorts.map(o => o.price))
          : 0;

        if (newEntry > highestShort) {
          console.log(`[TowerScheduler] CG空单机会: 新入场${newEntry.toFixed(0)} > 现有最高${highestShort.toFixed(0)}, top1=${top1.amount.toFixed(0)}M > top2=${top2.amount.toFixed(0)}M`);
          return { shouldUpdate: true, reason: `CG空单更优: ${newEntry.toFixed(0)} > ${highestShort.toFixed(0)}` };
        }
      }
    }

    return { shouldUpdate: false, reason: '无更优CG机会' };
  } catch (error) {
    console.error('[TowerScheduler] 检查CG机会异常:', error);
    return { shouldUpdate: false, reason: '检查异常' };
  }
}

/**
 * 获取杠杆倍数
 */
async function getLeverage(
  exchange: ExchangeType,
  exchangeConfig: exchangeAdapter.ExchangeApiConfig,
  symbol: string
): Promise<number> {
  try {
    // 通过获取持仓来获取杠杆
    const positionsResult = await exchangeAdapter.getPositions(exchange, exchangeConfig, symbol);
    if (positionsResult.success && positionsResult.positions && positionsResult.positions.length > 0) {
      const position = positionsResult.positions[0];
      if (position.leverage) {
        console.log(`[TowerScheduler] 获取杠杆: ${symbol} = ${position.leverage}x`);
        return position.leverage;
      }
    }

    console.warn('[TowerScheduler] 获取杠杆失败，使用默认值 20x');
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
  exchange: ExchangeType,
  exchangeConfig: exchangeAdapter.ExchangeApiConfig,
  symbol: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // 使用适配器取消所有 ict_tower 前缀的订单
    const result = await exchangeAdapter.cancelOrdersByPrefix(exchange, exchangeConfig, symbol, 'ict_tower');
    if (result.canceledCount > 0) {
      console.log(`[TowerScheduler] 取消了 ${result.canceledCount} 个订单`);
    }
    return { success: result.success, error: result.error };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络错误',
    };
  }
}

/**
 * 获取K线前高前低 - 同时计算 4D 和 1D，取更保守的 P/D 值
 * P = max(4D.P, 1D.P) → 卖得更高
 * D = min(4D.D, 1D.D) → 买得更低
 */
async function getDailyHL(symbol: string, currentPrice: number): Promise<DailyHL | null> {
  // 通用的锚定K线查找函数
  const findAnchor = (
    klines: Array<{ high: number; low: number }>,
    currentPrice: number
  ): { high: number; low: number } | null => {
    if (klines.length < 2) return null;

    const latestCandle = klines[klines.length - 1];

    // 从倒数第二根向左扫描，找到包含当前价格的K线
    for (let i = klines.length - 2; i >= 0; i--) {
      const { high, low } = klines[i];
      if (currentPrice >= low && currentPrice <= high) {
        return {
          high: Math.max(high, latestCandle.high),
          low: Math.min(low, latestCandle.low),
        };
      }
    }
    return null;
  };

  // 计算 P/D 区域
  const calculatePD = (high: number, low: number) => {
    const range = high - low;
    const quarterRange = range / 4;
    return {
      high,
      low,
      pStart: high - quarterRange,  // P区开始 (价格高于此为溢价区)
      dStart: low + quarterRange,   // D区开始 (价格低于此为折扣区)
    };
  };

  try {
    let pd4d: { high: number; low: number; pStart: number; dStart: number } | null = null;
    let pd1d: { high: number; low: number; pStart: number; dStart: number } | null = null;

    // 1. 尝试从 kline-server 获取 4D K线
    try {
      const klineApiUrl = process.env.KLINE_API_URL || 'http://127.0.0.1:3001';
      const response4d = await fetch(
        `${klineApiUrl}/api/klines/${symbol}/4d?limit=100`
      );

      if (response4d.ok) {
        const data4d = await response4d.json() as { klines: Array<{ high: number; low: number }> };
        if (data4d.klines && data4d.klines.length >= 2) {
          const anchor = findAnchor(data4d.klines, currentPrice);
          if (anchor) {
            pd4d = calculatePD(anchor.high, anchor.low);
          }
        }
      }
    } catch (e) {
      // 4D 不可用，继续
    }

    // 2. 获取 1D K线 (从 Binance API)
    const response1d = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=100`
    );

    if (response1d.ok) {
      const klines1d = await response1d.json() as Array<[number, string, string, string, string, ...unknown[]]>;
      const parsed1d = klines1d.map(k => ({
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
      }));

      const anchor = findAnchor(parsed1d, currentPrice);
      if (anchor) {
        pd1d = calculatePD(anchor.high, anchor.low);
      }
    }

    // 3. 合并结果：取更保守的值
    if (pd4d && pd1d) {
      // 两者都有，取 P 的最大值，D 的最小值
      const result: DailyHL = {
        high: Math.max(pd4d.high, pd1d.high),
        low: Math.min(pd4d.low, pd1d.low),
        pStart: Math.max(pd4d.pStart, pd1d.pStart),  // P 取大值，卖得更高
        dStart: Math.min(pd4d.dStart, pd1d.dStart),  // D 取小值，买得更低
      };
      console.log(`[TowerScheduler] HLPD 合并 4D+1D: P=${result.pStart.toFixed(0)} (4D:${pd4d.pStart.toFixed(0)}, 1D:${pd1d.pStart.toFixed(0)}), D=${result.dStart.toFixed(0)} (4D:${pd4d.dStart.toFixed(0)}, 1D:${pd1d.dStart.toFixed(0)})`);
      return result;
    } else if (pd4d) {
      console.log('[TowerScheduler] HLPD 仅使用 4D K线');
      return pd4d;
    } else if (pd1d) {
      console.log('[TowerScheduler] HLPD 仅使用 1D K线');
      return pd1d;
    }

    return null;
  } catch (error) {
    console.error('[TowerScheduler] 获取K线异常:', error);
    return null;
  }
}

/**
 * 获取 Coinglass 清算数据
 */
async function fetchCGLiqData(symbol: string): Promise<CGLiqData | null> {
  // 提取基础币种 (BTCUSDT -> BTC)
  const baseCoin = symbol.replace(/USDC?|USDT?|BUSD?/i, '');

  // 目前只支持 BTC
  if (baseCoin !== 'BTC') {
    console.log(`[TowerScheduler] CG 数据: ${baseCoin} 暂不支持`);
    return null;
  }

  try {
    const url = `${COINGLASS_SERVICE_URL}/api/liqmap/top?symbol=${baseCoin}&limit=10`;
    console.log(`[TowerScheduler] 获取 CG 数据: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[TowerScheduler] CG 服务返回错误: ${response.status}`);
      return null;
    }

    const result = await response.json() as {
      success: boolean;
      data?: {
        longTop: Array<{ price: number; amount: number }>;
        shortTop: Array<{ price: number; amount: number }>;
      };
    };

    if (!result.success || !result.data) {
      console.error('[TowerScheduler] CG 数据未就绪');
      return null;
    }

    console.log(`[TowerScheduler] CG 数据: 多头清算 ${result.data.longTop.length} 个, 空头清算 ${result.data.shortTop.length} 个`);
    return result.data;
  } catch (error) {
    console.error('[TowerScheduler] 获取 CG 数据异常:', error);
    return null;
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
  leverage: number,
  dailyHL: DailyHL | null,
  cgData: CGLiqData | null
): TowerOrder[] {
  const { currentPrice, blocks } = towerData;
  const { baseMargin, marginIncrement, towerLayers, bullishStartLayer, bearishStartLayer, minSpacingRatio } = management;

  console.log(`[TowerScheduler] 计算订单: 基础保证金=${baseMargin}, 递增=${marginIncrement}, 杠杆=${leverage}x`);

  // ===== CG 首单数据 =====
  // 如果有 CG 数据和日K的 P/D 区域，用于计算首单
  let cgFirstShort: { entry: number; stopLoss: number; takeProfit: number; liqPrice: number } | null = null;
  let cgFirstLong: { entry: number; stopLoss: number; takeProfit: number; liqPrice: number } | null = null;

  if (cgData && dailyHL) {
    // 空单首单：找 P 以上最大清算值
    const shortAboveP = cgData.shortTop.filter(s => s.price > dailyHL.pStart);
    if (shortAboveP.length > 0) {
      const maxShort = shortAboveP.reduce((max, s) => s.amount > max.amount ? s : max, shortAboveP[0]);
      // 入场偏移 = max(200, 清算价 * 0.2%)
      const offset = Math.max(200, maxShort.price * 0.002);
      const entry = maxShort.price - offset;
      // 入场价也必须 >= P（溢价区）
      if (entry >= dailyHL.pStart) {
        cgFirstShort = {
          liqPrice: maxShort.price,
          entry,
          stopLoss: entry + 300,  // 入场价 + 300 点
          takeProfit: entry * (1 - MIN_TP_RATIO),  // 入场价 - 2.5%
        };
        console.log(`[TowerScheduler] CG 首空单: P=${dailyHL.pStart.toFixed(0)}, 清算价=${maxShort.price}, 入场=${cgFirstShort.entry.toFixed(0)}, 止损=${cgFirstShort.stopLoss.toFixed(0)}`);
      } else {
        console.log(`[TowerScheduler] CG 首空单舍弃: 入场=${entry.toFixed(0)} < P=${dailyHL.pStart.toFixed(0)}`);
      }
    }

    // 多单首单：找 D 以下最大清算值
    const longBelowD = cgData.longTop.filter(l => l.price < dailyHL.dStart);
    if (longBelowD.length > 0) {
      const maxLong = longBelowD.reduce((max, l) => l.amount > max.amount ? l : max, longBelowD[0]);
      // 入场偏移 = max(200, 清算价 * 0.2%)
      const offset = Math.max(200, maxLong.price * 0.002);
      const entry = maxLong.price + offset;
      // 入场价也必须 <= D（折扣区）
      if (entry <= dailyHL.dStart) {
        cgFirstLong = {
          liqPrice: maxLong.price,
          entry,
          stopLoss: entry - 300,  // 入场价 - 300 点
          takeProfit: entry * (1 + MIN_TP_RATIO),  // 入场价 + 2.5%
        };
        console.log(`[TowerScheduler] CG 首多单: D=${dailyHL.dStart.toFixed(0)}, 清算价=${maxLong.price}, 入场=${cgFirstLong.entry.toFixed(0)}, 止损=${cgFirstLong.stopLoss.toFixed(0)}`);
      } else {
        console.log(`[TowerScheduler] CG 首多单舍弃: 入场=${entry.toFixed(0)} > D=${dailyHL.dStart.toFixed(0)}`);
      }
    }
  }

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

    // 止盈 = 最近的对立塔块，最小 2.5%
    const minTpDistance = block.entry * MIN_TP_RATIO;
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
      if (tpDistance >= minTpDistance) {
        block.takeProfit = target.entry;
      } else {
        block.takeProfit = block.type === 'bearish'
          ? block.entry * (1 - MIN_TP_RATIO)
          : block.entry * (1 + MIN_TP_RATIO);
      }
    } else {
      block.takeProfit = block.type === 'bearish'
        ? block.entry * (1 - MIN_TP_RATIO)
        : block.entry * (1 + MIN_TP_RATIO);
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
  // 添加区域过滤: 多单只在折扣区(D区), 空单只在溢价区(P区)
  let bullishCandidates = sortByDistance(
    allBullish.filter(b => b.entry < currentPrice && currentPrice - b.entry >= minDistance),
    currentPrice
  );

  let bearishCandidates = sortByDistance(
    allBearish.filter(b => b.entry > currentPrice && b.entry - currentPrice >= minDistance),
    currentPrice
  );

  // 区域过滤: 只在折扣区开多，只在溢价区开空
  if (dailyHL) {
    const originalBullishCount = bullishCandidates.length;
    const originalBearishCount = bearishCandidates.length;

    // 多单: 入场价必须 <= D区开始 (折扣区)
    bullishCandidates = bullishCandidates.filter(b => b.entry <= dailyHL.dStart);
    // 空单: 入场价必须 >= P区开始 (溢价区)
    bearishCandidates = bearishCandidates.filter(b => b.entry >= dailyHL.pStart);

    console.log(`[TowerScheduler] 区域过滤: H=${dailyHL.high.toFixed(0)} P=${dailyHL.pStart.toFixed(0)} D=${dailyHL.dStart.toFixed(0)} L=${dailyHL.low.toFixed(0)}`);
    console.log(`[TowerScheduler] 多单: ${originalBullishCount} -> ${bullishCandidates.length} (需 <= D=${dailyHL.dStart.toFixed(0)})`);
    console.log(`[TowerScheduler] 空单: ${originalBearishCount} -> ${bearishCandidates.length} (需 >= P=${dailyHL.pStart.toFixed(0)})`);
  } else {
    console.log(`[TowerScheduler] 未获取到日K数据，跳过区域过滤`);
  }

  // CG 清算价位置过滤：ICT 塔块必须在清算价的外侧
  // 多单：ICT 塔块必须在最大多头清算价以下
  // 空单：ICT 塔块必须在最大空头清算价以上
  if (cgFirstLong) {
    const before = bullishCandidates.length;
    bullishCandidates = bullishCandidates.filter(b => b.entry < cgFirstLong.liqPrice);
    console.log(`[TowerScheduler] CG 多单过滤: ${before} -> ${bullishCandidates.length} (需 < 清算价 ${cgFirstLong.liqPrice.toFixed(0)})`);
  }
  if (cgFirstShort) {
    const before = bearishCandidates.length;
    bearishCandidates = bearishCandidates.filter(b => b.entry > cgFirstShort.liqPrice);
    console.log(`[TowerScheduler] CG 空单过滤: ${before} -> ${bearishCandidates.length} (需 > 清算价 ${cgFirstShort.liqPrice.toFixed(0)})`);
  }

  // 如果有 CG 首单，ICT 塔块只需要 towerLayers - 1 个
  const bullishLayersNeeded = cgFirstLong ? towerLayers - 1 : towerLayers;
  const bearishLayersNeeded = cgFirstShort ? towerLayers - 1 : towerLayers;

  const selectedBullish = filterWithSpacing(bullishCandidates, bullishStartLayer, bullishLayersNeeded);
  const selectedBearish = filterWithSpacing(bearishCandidates, bearishStartLayer, bearishLayersNeeded);

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

  // ===== 多单：首单用 CG，后续用 ICT =====
  let bullishIndex = 0;

  // 1. CG 首多单
  if (cgFirstLong) {
    const margin = baseMargin + bullishIndex * marginIncrement;
    const positionValue = margin * leverage;
    const quantity = Math.floor((positionValue / cgFirstLong.entry) * 1000) / 1000;

    orders.push({
      side: 'BUY',
      positionSide: 'LONG',
      price: cgFirstLong.entry,
      quantity,
      stopLoss: cgFirstLong.stopLoss,
      takeProfit: cgFirstLong.takeProfit,
      margin,
      timeframe: 'CG',
      source: 'LIQ',
    });
    bullishIndex++;
  }

  // 2. ICT 塔块多单
  for (let i = 0; i < orderedBullish.length; i++) {
    const block = orderedBullish[i];
    const margin = baseMargin + bullishIndex * marginIncrement;
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
    bullishIndex++;
  }

  // ===== 空单：首单用 CG，后续用 ICT =====
  let bearishIndex = 0;

  // 1. CG 首空单
  if (cgFirstShort) {
    const margin = baseMargin + bearishIndex * marginIncrement;
    const positionValue = margin * leverage;
    const quantity = Math.floor((positionValue / cgFirstShort.entry) * 1000) / 1000;

    orders.push({
      side: 'SELL',
      positionSide: 'SHORT',
      price: cgFirstShort.entry,
      quantity,
      stopLoss: cgFirstShort.stopLoss,
      takeProfit: cgFirstShort.takeProfit,
      margin,
      timeframe: 'CG',
      source: 'LIQ',
    });
    bearishIndex++;
  }

  // 2. ICT 塔块空单
  for (let i = 0; i < orderedBearish.length; i++) {
    const block = orderedBearish[i];
    const margin = baseMargin + bearishIndex * marginIncrement;
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
    bearishIndex++;
  }

  return orders;
}

/**
 * 下单（入场单 + 止盈止损单）
 */
async function placeOrders(
  exchange: ExchangeType,
  exchangeConfig: exchangeAdapter.ExchangeApiConfig,
  symbol: string,
  orders: TowerOrder[],
  trailingConfig: { activationRatio: number; callbackRate: number }
): Promise<{ success: number; errors: string[] }> {
  let success = 0;
  const errors: string[] = [];

  for (const order of orders) {
    try {
      // 格式: ict_tower_{级别}_{ICT种类}_{点位}
      // 例如: ict_tower_4h_OB_95000 (21字符,Binance限制<36)
      const priceStr = Math.round(order.price).toString();
      const clientOrderId = `ict_tower_${order.timeframe}_${order.source}_${priceStr}`;

      // 1. 下入场单（限价单）
      const entryResult = await exchangeAdapter.placeLimitOrder(exchange, exchangeConfig, {
        symbol,
        side: order.side,
        positionSide: order.positionSide,
        quantity: order.quantity,
        price: order.price,
        clientOrderId,
      });

      if (!entryResult.success) {
        errors.push(`入场 ${order.side} @ ${order.price}: ${entryResult.error}`);
        continue;
      }

      console.log(`[TowerScheduler] 入场单: ${order.side} @ ${order.price}, 保证金=${order.margin}, 数量=${order.quantity.toFixed(3)}, SL=${order.stopLoss.toFixed(1)}, TP=${order.takeProfit.toFixed(1)}`);

      // 平仓方向
      const closeSide = order.side === 'BUY' ? 'SELL' : 'BUY';

      // 2. 下止损单（STOP_MARKET）
      await delay(100);
      const slResult = await exchangeAdapter.placeStopLossOrder(exchange, exchangeConfig, {
        symbol,
        side: closeSide,
        positionSide: order.positionSide,
        quantity: order.quantity,
        stopPrice: order.stopLoss,
        clientOrderId: `${clientOrderId}_sl`,
      });

      if (!slResult.success) {
        console.warn(`[TowerScheduler] 止损单失败: ${slResult.error}`);
      } else {
        console.log(`[TowerScheduler] 止损单下单成功: ${clientOrderId}_sl`);
      }

      // 止盈单不在此处下，等入场单成交后由 orderMonitor 下单

      success++;

      // 保存待处理订单（用于成交后补下追踪止盈）
      await savePendingOrder({
        clientOrderId,
        symbol,
        exchange,
        side: order.side,
        positionSide: order.positionSide,
        quantity: order.quantity,
        entryPrice: order.price,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        trailingActivationRatio: trailingConfig.activationRatio,
        trailingCallbackRate: trailingConfig.callbackRate,
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
  exchange: ExchangeType;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  trailingActivationRatio?: number;
  trailingCallbackRate?: number;
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
    // 多单：止损在下方，止盈在上方 (2.5%)
    return {
      stopLoss: entryPrice - MAX_SL_DISTANCE,
      takeProfit: entryPrice * (1 + MIN_TP_RATIO),
    };
  } else {
    // 空单：止损在上方，止盈在下方 (2.5%)
    return {
      stopLoss: entryPrice + MAX_SL_DISTANCE,
      takeProfit: entryPrice * (1 - MIN_TP_RATIO),
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
