/**
 * 守塔托管调度器
 * 后台定时执行守塔策略
 */

import {
  getActiveManagements,
  updateRunTime,
  updateLastBias,
  addRecord,
  TowerManagementConfig,
  initTowerManagementTables,
  ExchangeType,
} from './towerManagementStore';
import { getBinanceApiConfig, getAsterApiConfig } from '../order/apiConfigReader';
import { fetchTowerBlocks } from './towerBlocksFetcher';
import { sendDingtalkMarkdownToUser } from '../notification/dingtalk';
import * as exchangeAdapter from '../order/exchangeAdapter';
import { config } from '../config';
import { fetchKlines } from '../data/klineClient';
import { computeAllSessionBiases, BiasDirection } from './sessionBias';
import { calculateNearbyPivots } from './nearbyPivots';

// 调度器状态
let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

// 止损止盈参数
// 止损统一固定 200 点（MAX_SL_DISTANCE），不再用 SL_RATIO 百分比
const MAX_SL_DISTANCE = 200;    // 固定止损点数
const MIN_TP_RATIO = 0.025;  // 止盈最小 2.5%
const LH_HL_OFFSET = 100;     // LH/HL 不破单偏移：HH-100 / LL+100
const ENTRY_OFFSET = 30;        // 入场"让点位"幅度（与 OTE/FVG 面板手点一致：BUY +30，SELL -30）

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

// 是否使用 Coinglass 清算数据（默认关闭）
const USE_CG_DATA = process.env.TOWER_USE_CG_DATA === 'true';

// 来源优先级（OTE > OB > FVG）
const SOURCE_PRIORITY: Record<string, number> = {
  'OTE': 3,
  'OB': 2,
  'FVG': 1,
};

// 时间周期优先级（小级别优先：15m > 1h > 4h > 1d）
const TIMEFRAME_PRIORITY: Record<string, number> = {
  '15m': 4, '1h': 3, '4h': 2, '1d': 1
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

  // 显示距离过滤配置
  const { orderDistanceFilter, orderDistanceThreshold } = config.tower;
  if (orderDistanceFilter) {
    console.log(`[TowerScheduler] 距离过滤: 开启 (阈值 ${orderDistanceThreshold * 100}%)`);
  } else {
    console.log(`[TowerScheduler] 距离过滤: 关闭`);
  }

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

    // 1. 检查持仓状态（有持仓时跳过重排，避免再加仓或对冲）
    const positionsResult = await exchangeAdapter.getPositions(exchange, exchangeConfig, management.symbol);
    let currentPositions: { positionSide: string; positionAmt: number }[] = [];
    if (positionsResult.success && positionsResult.positions) {
      currentPositions = positionsResult.positions.filter(p => Math.abs(p.positionAmt) >= 0.001);
    }

    // 判断当前持仓方向
    const hasLongPosition = currentPositions.some(p => p.positionSide === 'LONG');
    const hasShortPosition = currentPositions.some(p => p.positionSide === 'SHORT');

    // 已经有持仓时跳过整个重排流程（SL/TP 由 orderMonitor 维护）
    if (currentPositions.length > 0) {
      console.log(`[TowerScheduler] 已有持仓 (${currentPositions.map(p => `${p.positionSide} ${p.positionAmt}`).join(', ')})，跳过本次重排`);
      addRecord({
        managementId: management.id,
        bullishCount: 0,
        bearishCount: 0,
        totalMargin: 0,
        success: true,
        skipped: true,
        errorMessage: '已有持仓，跳过重排',
      });
      updateRunTime(management.id);
      return;
    }

    // 2. 取消反向订单 —— 已在上一步 early return，有持仓时不会到这里
    // 保留函数 cancelOppositeOrders() 以防未来需要恢复这个行为

    // 3. 检查当前订单数量和位置
    const orderCheck = await checkOrdersCount(exchange, exchangeConfig, management.symbol, management.towerLayers);

    // 3.5 计算 active bias (如果开启了 biasFilter)
    let activeBias: BiasDirection | 'wait' = 'wait';
    let activeBiasSession: 'AO' | 'EO' | 'AI' | null = null;
    if (management.biasFilter === 1) {
      try {
        const [hourlyCandles, fifteenMinCandles] = await Promise.all([
          fetchKlines(management.symbol, '1h', 200).catch(() => []),
          fetchKlines(management.symbol, '15m', 200).catch(() => []),
        ]);
        const biases = computeAllSessionBiases(hourlyCandles, fifteenMinCandles);
        activeBias = biases.active;
        activeBiasSession = biases.activeSession;
        console.log(`[TowerScheduler] ${management.symbol} biasFilter=1, active=${activeBiasSession} bias=${activeBias}`);
      } catch (e) {
        console.error(`[TowerScheduler] 计算 bias 失败:`, e);
        activeBias = 'wait';
      }

      if (activeBias === 'wait') {
        // bias 不明确（wait 是中性），不撤单、不过滤新单，继续走正常流程
        // 旧挂单保留，新订单也无 bias filter（line 477 的 filter 条件包含 activeBias !== 'wait'）
        console.log(`[TowerScheduler] bias=wait（中性），保留旧单，不应用 bias filter`);
      } else {
        // 3.6 MTF 翻向检测：只有 long↔short 明确反向才撤旧 bias 入场单
        // - prevBias=wait → 不算翻向（中性切换）
        // - prevBias==activeBias → 不算翻向
        // - wait↔wait → 不算翻向
        // 持仓保留（SL/TP 不动），只撤"旧 bias 同向"的入场单
        const prevBias = management.lastBias;
        if (prevBias !== 'wait' && prevBias !== activeBias) {
          console.log(`[TowerScheduler] MTF 翻向: ${prevBias} → ${activeBias}, 撤旧 bias (${prevBias}) 入场单`);
          const flipResult = await cancelEntriesByOldBias(
            exchange,
            exchangeConfig,
            management.symbol,
            prevBias  // 旧 bias，决定要撤哪一边的单
          );
          if (flipResult.canceledCount > 0) {
            console.log(`[TowerScheduler] 翻向撤单完成: ${flipResult.canceledCount} 个`);
          }
        }
      }
    }

    // 如果有订单在 P/D 中性区域，强制重新排列
    if (orderCheck.hasOrderInNeutralZone) {
      console.log(`[TowerScheduler] 中性区域有订单，强制重新排列`);
      // 继续执行，不跳过
    } else if (orderCheck.sufficient || orderCheck.hasNearOrder) {
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

    // 4. 取消现有订单（无持仓时全部取消，有持仓时已在上一步取消反向订单）
    if (!hasLongPosition && !hasShortPosition) {
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
    } else {
      console.log(`[TowerScheduler] 有持仓，跳过全量取消订单`);
    }

    // 等待订单取消完成
    await delay(500);

    // 5. 获取杠杆
    const leverage = await getLeverage(exchange, exchangeConfig, management.symbol);

    // 6. 计算 effectiveBaseMargin
    // 优先级：marginPercent > 0 → balance × percent/100
    //          baseMargin > 0 → 固定 USD
    //          都为 0 → 报错（不挂单）
    let effectiveBaseMargin = management.baseMargin;
    if (management.marginPercent && management.marginPercent > 0) {
      const balanceResult = await exchangeAdapter.getFuturesBalance(exchange, exchangeConfig);
      if (balanceResult.success && balanceResult.balance) {
        effectiveBaseMargin = Math.floor((balanceResult.balance * management.marginPercent) / 100);
        // 至少 10U
        effectiveBaseMargin = Math.max(10, effectiveBaseMargin);
        // 不再向下取整到 10——会腰斩小余额（如 19 → 10）。只取整到 1U
        effectiveBaseMargin = Math.floor(effectiveBaseMargin);
        console.log(`[TowerScheduler] 账户百分比模式: 余额=${balanceResult.balance.toFixed(2)}, ${management.marginPercent}% = ${effectiveBaseMargin}U`);
      } else {
        console.warn('[TowerScheduler] 获取余额失败，回退到 baseMargin');
        effectiveBaseMargin = management.baseMargin;
      }
    }
    if (effectiveBaseMargin === 0) {
      console.warn('[TowerScheduler] 保证金为 0（marginPercent=0 且 baseMargin=0），跳过本次执行');
      addRecord({
        managementId: management.id,
        bullishCount: 0,
        bearishCount: 0,
        totalMargin: 0,
        success: false,
        skipped: true,
        errorMessage: '保证金为 0',
      });
      updateRunTime(management.id);
      return;
    }

    // 创建临时的 management 配置（使用计算后的 baseMargin）
    const effectiveManagement = {
      ...management,
      baseMargin: effectiveBaseMargin,
    };

    // 7. 获取日K前高前低（用于区域过滤）
    const dailyHL = await getDailyHL(management.symbol, towerData.currentPrice);

    // 8. 获取 Coinglass 清算数据（可选，默认关闭）
    const cgData = USE_CG_DATA ? await fetchCGLiqData(management.symbol) : null;

    // 9. 计算要下的订单
    let orders = await calculateOrders(towerData, effectiveManagement, leverage, dailyHL, cgData);

    // 9.5 bias filter: 只保留与 activeBias 同向的订单
    if (management.biasFilter === 1 && activeBias !== 'wait') {
      const before = orders.length;
      const targetSide = activeBias === 'long' ? 'BUY' : 'SELL';
      orders = orders.filter(o => o.side === targetSide);
      console.log(`[TowerScheduler] bias filter (${activeBias}=${targetSide}): ${before} -> ${orders.length} orders`);
    }

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

    // 10. 下单
    const result = await placeOrders(exchange, exchangeConfig, management.symbol, orders, {
      activationRatio: management.trailingActivationRatio,
      callbackRate: management.trailingCallbackRate,
    });

    // 11. 记录结果
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

    // 更新 lastBias（仅 long/short 写入，wait 保留上次）
    if (management.biasFilter === 1) {
      updateLastBias(management.id, activeBias);
    }

    const duration = Date.now() - startTime;
    const autoModeInfo = management.baseMargin === 0 ? `(自动模式:${effectiveBaseMargin}U) ` : '';
    const biasInfo = management.biasFilter === 1 ? `, bias=${activeBiasSession}:${activeBias}` : '';
    console.log(`[TowerScheduler] 执行完成: ${orders.length}单(入场+止盈止损), 杠杆=${leverage}x, ${autoModeInfo}总保证金=${totalMargin} USDT, ${result.errors.length}错误, 耗时${duration}ms${biasInfo}`);

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
): Promise<{ bullish: number; bearish: number; sufficient: boolean; hasNearOrder: boolean; hasOrderInNeutralZone: boolean }> {
  try {
    // 获取挂单
    const ordersResult = await exchangeAdapter.getOpenOrders(exchange, exchangeConfig, symbol);
    if (!ordersResult.success || !ordersResult.orders) {
      return { bullish: 0, bearish: 0, sufficient: false, hasNearOrder: false, hasOrderInNeutralZone: false };
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

    // 检查是否有订单在 P/D 中性区域（需要重新排列）
    let hasOrderInNeutralZone = false;
    if (currentPrice > 0) {
      const dailyHL = await getDailyHL(symbol, currentPrice);
      if (dailyHL) {
        // 中性区域：D < price < P
        const neutralOrders = towerOrders.filter(o =>
          o.price > dailyHL.dStart && o.price < dailyHL.pStart
        );
        if (neutralOrders.length > 0) {
          hasOrderInNeutralZone = true;
          console.log(`[TowerScheduler] 发现 ${neutralOrders.length} 个订单在中性区域 (D=${dailyHL.dStart.toFixed(0)} ~ P=${dailyHL.pStart.toFixed(0)}): ${neutralOrders.map(o => `${o.side}@${o.price.toFixed(0)}`).join(', ')}`);
        }
      }
    }

    return { bullish, bearish, sufficient, hasNearOrder, hasOrderInNeutralZone };
  } catch (error) {
    console.error('[TowerScheduler] 检查订单失败:', error);
    return { bullish: 0, bearish: 0, sufficient: false, hasNearOrder: false, hasOrderInNeutralZone: false };
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

    // 4. 获取 CG 数据（可选，默认关闭）
    const cgData = USE_CG_DATA ? await fetchCGLiqData(symbol) : null;
    if (!cgData && USE_CG_DATA) {
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

    // 5.6-5.9 CG 检查（只有开启 CG 数据时才执行）
    if (cgData) {
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
    } // 结束 if (cgData)

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
 * 取消反向订单（根据持仓方向选择性取消）
 * 有多头持仓时只取消空单，有空头持仓时只取消多单
 */
async function cancelOppositeOrders(
  exchange: ExchangeType,
  exchangeConfig: exchangeAdapter.ExchangeApiConfig,
  symbol: string,
  hasLongPosition: boolean,
  hasShortPosition: boolean
): Promise<{ success: boolean; error?: string; canceledCount: number }> {
  try {
    // 获取当前挂单
    const ordersResult = await exchangeAdapter.getOpenOrders(exchange, exchangeConfig, symbol);
    if (!ordersResult.success || !ordersResult.orders) {
      return { success: true, error: undefined, canceledCount: 0 };
    }

    const towerOrders = ordersResult.orders.filter(
      o => o.clientOrderId?.startsWith('ict_tower') && o.type === 'LIMIT'
    );

    if (towerOrders.length === 0) {
      return { success: true, error: undefined, canceledCount: 0 };
    }

    // 确定要取消的订单方向
    let sidesToCancel: string[] = [];
    if (hasLongPosition) {
      // 有多头持仓 → 取消空单（SELL）
      sidesToCancel.push('SELL');
    }
    if (hasShortPosition) {
      // 有空头持仓 → 取消多单（BUY）
      sidesToCancel.push('BUY');
    }

    if (sidesToCancel.length === 0) {
      return { success: true, error: undefined, canceledCount: 0 };
    }

    // 找出要取消的入场单（不带 _sl、_tp 后缀）
    const ordersToCancel = towerOrders.filter(o =>
      sidesToCancel.includes(o.side) &&
      !o.clientOrderId?.endsWith('_sl') &&
      !o.clientOrderId?.endsWith('_tp') &&
      !o.clientOrderId?.startsWith('ict_protect_')
    );
    if (ordersToCancel.length === 0) {
      return { success: true, error: undefined, canceledCount: 0 };
    }

    console.log(`[TowerScheduler] 取消反向订单: ${ordersToCancel.map(o => `${o.side}@${o.price}`).join(', ')}`);

    // 逐个取消
    let canceledCount = 0;
    for (const order of ordersToCancel) {
      const result = await exchangeAdapter.cancelOrder(exchange, exchangeConfig, symbol, order.orderId);
      if (result.success) {
        canceledCount++;
      }
      await delay(50);
    }

    return { success: true, error: undefined, canceledCount };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络错误',
      canceledCount: 0,
    };
  }
}

/**
 * MTF bias 翻转时，撤销"旧 bias 同向"的未成交入场单
 * - 只撤入场单（带 ict_tower 前缀，不带 _sl/_tp）
 * - 保留止损 (_sl)、止盈 (_tp)、保护单 (ict_protect_)
 * - 不动持仓
 * - oldBias='long' → 撤 BUY 入场单（旧 long bias 时下的）
 * - oldBias='short' → 撤 SELL 入场单（旧 short bias 时下的）
 */
async function cancelEntriesByOldBias(
  exchange: ExchangeType,
  exchangeConfig: exchangeAdapter.ExchangeApiConfig,
  symbol: string,
  oldBias: 'long' | 'short'
): Promise<{ success: boolean; canceledCount: number; error?: string }> {
  try {
    // 旧 bias=long 时下的是 BUY 单，short 时下的是 SELL 单
    const oldBiasSide = oldBias === 'long' ? 'BUY' : 'SELL';

    const ordersResult = await exchangeAdapter.getOpenOrders(exchange, exchangeConfig, symbol);
    if (!ordersResult.success || !ordersResult.orders) {
      return { success: true, canceledCount: 0 };
    }

    // 只挑入场单：ict_tower 前缀 + 不带 _sl/_tp + 不是保护单
    const toCancel = ordersResult.orders.filter(o =>
      o.side === oldBiasSide &&
      o.clientOrderId?.startsWith('ict_tower') &&
      !o.clientOrderId?.endsWith('_sl') &&
      !o.clientOrderId?.endsWith('_tp') &&
      !o.clientOrderId?.startsWith('ict_protect_')
    );

    if (toCancel.length === 0) {
      return { success: true, canceledCount: 0 };
    }

    console.log(`[TowerScheduler] MTF 翻向 → 撤旧 bias (${oldBias}=${oldBiasSide}) 入场单: ${toCancel.map(o => `${o.side}@${o.price}`).join(', ')}`);

    let canceledCount = 0;
    for (const order of toCancel) {
      const result = await exchangeAdapter.cancelOrder(exchange, exchangeConfig, symbol, order.orderId);
      if (result.success) {
        canceledCount++;
      }
      await delay(50);
    }

    return { success: true, canceledCount };
  } catch (error) {
    return {
      success: false,
      canceledCount: 0,
      error: error instanceof Error ? error.message : '网络错误',
    };
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
        `${klineApiUrl}/api/klines/${symbol}/4d?limit=200`
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
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=200`
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

async function calculateOrders(
  towerData: { currentPrice: number; blocks: Array<{ type: string; entry: number; high: number; low: number; source: string; timeframe: string }> },
  management: TowerManagementConfig,
  leverage: number,
  dailyHL: DailyHL | null,
  cgData: CGLiqData | null
): Promise<TowerOrder[]> {
  const { currentPrice, blocks: rawBlocks } = towerData;
  const { baseMargin, marginIncrement, towerLayers, bullishStartLayer, bearishStartLayer, minSpacingRatio, bullishLowFilter, bearishHighFilter, useHLPDFilter, monitorTimeframe } = management;

  // 周期过滤：默认只看当前 monitorTimeframe（user 设的，或 '15m' 默认）
  // monitorTimeframe='0' = 所有周期（保留兼容）
  const blocks = monitorTimeframe && monitorTimeframe !== '0'
    ? rawBlocks.filter(b => b.timeframe === monitorTimeframe)
    : rawBlocks;

  console.log(`[TowerScheduler] 计算订单: 基础保证金=${baseMargin}, 递增=${marginIncrement}, 杠杆=${leverage}x, 多L过滤=${bullishLowFilter}, 空H过滤=${bearishHighFilter}, HLPD过滤=${useHLPDFilter}, 周期过滤=${monitorTimeframe || '0'}(原始${rawBlocks.length}->过滤后${blocks.length})`);

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
  // 止损：固定 200 点（不再紧贴结构边界，确保风险一致）
  for (const block of [...allBearish, ...allBullish]) {
    if (block.type === 'bearish') {
      // 空单：SL 在 entry 之上 200 点
      block.stopLoss = block.entry + MAX_SL_DISTANCE;
    } else {
      // 多单：SL 在 entry 之下 200 点
      block.stopLoss = block.entry - MAX_SL_DISTANCE;
    }

    // 止盈 = max(固定止盈 2.5%, P/D 距离)
    // 多单：止盈 = max(入场价 × 1.025, P)
    // 空单：止盈 = min(入场价 × 0.975, D)
    const minTpDistance = block.entry * MIN_TP_RATIO;
    let target: typeof block | undefined;

    if (block.type === 'bearish') {
      const candidates = allBullish.filter(b => b.entry < block.entry);
      target = candidates[0];
    } else {
      const candidates = allBearish.filter(b => b.entry > block.entry);
      target = candidates[candidates.length - 1];
    }

    // 先计算基础止盈（对立塔块或固定 2.5%）
    let baseTp: number;
    if (target) {
      const tpDistance = Math.abs(target.entry - block.entry);
      if (tpDistance >= minTpDistance) {
        baseTp = target.entry;
      } else {
        baseTp = block.type === 'bearish'
          ? block.entry * (1 - MIN_TP_RATIO)
          : block.entry * (1 + MIN_TP_RATIO);
      }
    } else {
      baseTp = block.type === 'bearish'
        ? block.entry * (1 - MIN_TP_RATIO)
        : block.entry * (1 + MIN_TP_RATIO);
    }

    // 与 P/D 比较，取更优的止盈
    if (dailyHL) {
      if (block.type === 'bearish') {
        // 空单：止盈 = min(baseTp, D)，取更低的价格
        block.takeProfit = Math.min(baseTp, dailyHL.dStart);
      } else {
        // 多单：止盈 = max(baseTp, P)，取更高的价格
        block.takeProfit = Math.max(baseTp, dailyHL.pStart);
      }
    } else {
      block.takeProfit = baseTp;
    }
  }

  // 最小距离（启动间距，千分比）
  const { minEntryDistance = 5, maxEntryDistancePercent = 20 } = management;  // maxEntryDistancePercent 存的是 整数×10，例如 20 = 2.0%
  const minDistance = currentPrice * (minEntryDistance / 1000);
  const maxDistance = currentPrice * (maxEntryDistancePercent / 100);  // 百分比 → 点数
  // 最小间距（万分之 N）
  const minSpacing = currentPrice * (minSpacingRatio / 10000);

  console.log(`[TowerScheduler] 距离范围: ${(minDistance / currentPrice * 100).toFixed(2)}% - ${(maxDistance / currentPrice * 100).toFixed(2)}% (${minDistance.toFixed(0)} - ${maxDistance.toFixed(0)} 点)`);

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

  // 排序函数：来源优先 (OTE > OB > FVG) > 时间周期优先 (15m > 1h > 4h > 1d) > 距离近的优先
  const sortByPriority = (
    blocks: typeof allBullish,
    currentPrice: number
  ) => {
    // 只按距离排序：最近的 block 最优先（不管 OTE/OB/FVG，不管 TF）
    return blocks.sort((a, b) => {
      return Math.abs(a.entry - currentPrice) - Math.abs(b.entry - currentPrice);
    });
  };

  // 筛选塔块
  // 距离过滤：必须在 [minDistance, maxDistance] 范围内（默认 0.5% - 2.0%）
  // 添加区域过滤: 多单只在折扣区(D区), 空单只在溢价区(P区)
  let bullishCandidates = sortByPriority(
    allBullish.filter(b => {
      const dist = currentPrice - b.entry;
      return dist >= minDistance && dist <= maxDistance;
    }),
    currentPrice
  );

  let bearishCandidates = sortByPriority(
    allBearish.filter(b => {
      const dist = b.entry - currentPrice;
      return dist >= minDistance && dist <= maxDistance;
    }),
    currentPrice
  );

  console.log(`[TowerScheduler] 距离过滤后候选: 多 ${bullishCandidates.length} 个, 空 ${bearishCandidates.length} 个`);

  // 区域过滤: 只在折扣区开多，只在溢价区开空（可通过 useHLPDFilter 关闭）
  if (dailyHL && useHLPDFilter) {
    const originalBullishCount = bullishCandidates.length;
    const originalBearishCount = bearishCandidates.length;

    // 多单: 入场价必须 <= D区开始 (折扣区)
    bullishCandidates = bullishCandidates.filter(b => b.entry <= dailyHL.dStart);
    // 空单: 入场价必须 >= P区开始 (溢价区)
    bearishCandidates = bearishCandidates.filter(b => b.entry >= dailyHL.pStart);

    console.log(`[TowerScheduler] 区域过滤: H=${dailyHL.high.toFixed(0)} P=${dailyHL.pStart.toFixed(0)} D=${dailyHL.dStart.toFixed(0)} L=${dailyHL.low.toFixed(0)}`);
    console.log(`[TowerScheduler] 多单: ${originalBullishCount} -> ${bullishCandidates.length} (需 <= D=${dailyHL.dStart.toFixed(0)})`);
    console.log(`[TowerScheduler] 空单: ${originalBearishCount} -> ${bearishCandidates.length} (需 >= P=${dailyHL.pStart.toFixed(0)})`);
  } else if (!useHLPDFilter) {
    console.log(`[TowerScheduler] HLPD区域过滤已关闭，跳过 P/D 区域限制`);
  } else {
    console.log(`[TowerScheduler] 未获取到日K数据，跳过区域过滤`);
  }

  // 距离过滤: 价格远离 P/D 超过阈值时不下单
  const { orderDistanceFilter, orderDistanceThreshold } = config.tower;
  if (orderDistanceFilter) {
    const distanceFilter = (b: typeof allBullish[0], type: 'bullish' | 'bearish') => {
      if (!dailyHL) return true;
      const pdStart = type === 'bullish' ? dailyHL.dStart : dailyHL.pStart;
      const distance = Math.abs(b.entry - pdStart);
      const priceRatio = distance / currentPrice;
      if (priceRatio > orderDistanceThreshold) {
        console.log(`[TowerScheduler] 距离过滤跳过: ${type} ${b.entry.toFixed(0)} (距${type === 'bullish' ? 'D' : 'P'} ${(priceRatio * 100).toFixed(2)}% > ${orderDistanceThreshold * 100}%)`);
        return false;
      }
      return true;
    };

    const beforeBullish = bullishCandidates.length;
    const beforeBearish = bearishCandidates.length;
    bullishCandidates = bullishCandidates.filter(b => distanceFilter(b, 'bullish'));
    bearishCandidates = bearishCandidates.filter(b => distanceFilter(b, 'bearish'));
    console.log(`[TowerScheduler] 距离过滤: 多单 ${beforeBullish} -> ${bullishCandidates.length}, 空单 ${beforeBearish} -> ${bearishCandidates.length}`);
  }

  // 多L空H过滤：只下L以下的多单，只下H以上的空单
  if (dailyHL) {
    const originalBullishCount = bullishCandidates.length;
    const originalBearishCount = bearishCandidates.length;

    // 多单过滤：bullishLowFilter=1 时，只下 L 以下的多单（L = dailyHL.low）
    if (bullishLowFilter === 1) {
      bullishCandidates = bullishCandidates.filter(b => b.entry <= dailyHL.low);
      console.log(`[TowerScheduler] 多L过滤: ${originalBullishCount} -> ${bullishCandidates.length} (需 <= L=${dailyHL.low.toFixed(0)})`);
    }

    // 空单过滤：bearishHighFilter=1 时，只下 H 以上的空单（H = dailyHL.high）
    if (bearishHighFilter === 1) {
      bearishCandidates = bearishCandidates.filter(b => b.entry >= dailyHL.high);
      console.log(`[TowerScheduler] 空H过滤: ${originalBearishCount} -> ${bearishCandidates.length} (需 >= H=${dailyHL.high.toFixed(0)})`);
    }
  }

  // ICT 塔块选取：每个方向最多 1 个（你手动看 15m 单 TF 也是 1 个 OTE/OB）
  const maxLayersPerDirection = Math.min(towerLayers, 1);
  let selectedBullish = filterWithSpacing(bullishCandidates, bullishStartLayer, maxLayersPerDirection);
  let selectedBearish = filterWithSpacing(bearishCandidates, bearishStartLayer, maxLayersPerDirection);

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

  // ===== ICT 多单 =====
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

  // ===== ICT 空单 =====
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

  // ===== LH/HL 不破单（独立于 ICT，不占层数）=====
  // SELL：在最近的高点（HH）下方 100 点，bet on rejection
  // BUY：在最近的低点（LL）上方 100 点，bet on bounce
  // 使用 1h TF + lookback=5，与「实时通道监控」算法一致
  if (management.lhHlOrders === 1) {
    try {
      const lhHlCandles = await fetchKlines(management.symbol, '1h', 300);
      const pivots = calculateNearbyPivots(lhHlCandles, currentPrice, 5);

      // 最近的高点 = pivots.lh（pivots.hh 是更早的；只有 1 个高点时 lh 为 null，fallback 到 hh）
      const recentHigh = pivots.lh?.price ?? pivots.hh?.price;
      if (recentHigh && recentHigh > currentPrice) {
        // HH - 100 → SELL（不破 HH）
        const lhEntry = recentHigh - LH_HL_OFFSET;
        if (lhEntry > currentPrice) {
          const lhTp = lhEntry * (1 - MIN_TP_RATIO);
          const lhMargin = baseMargin;
          const lhPositionValue = lhMargin * leverage;
          const lhQuantity = Math.floor((lhPositionValue / lhEntry) * 1000) / 1000;
          orders.push({
            side: 'SELL',
            positionSide: 'SHORT',
            price: lhEntry,
            quantity: lhQuantity,
            stopLoss: 0,  // 由 placeOrders 用 entryPrice ± 200 重算
            takeProfit: lhTp,
            margin: lhMargin,
            timeframe: '1h',
            source: 'LH',
          });
          console.log(`[TowerScheduler] LH不破单: SELL @ ${lhEntry.toFixed(0)} (最近HH=${recentHigh.toFixed(0)} - ${LH_HL_OFFSET}), TP=${lhTp.toFixed(0)}`);
        }
      }

      // 最近的低点 = pivots.hl（pivots.ll 是更早的；只有 1 个低点时 hl 为 null，fallback 到 ll）
      const recentLow = pivots.hl?.price ?? pivots.ll?.price;
      if (recentLow && recentLow < currentPrice) {
        // LL + 100 → BUY（不破 LL）
        const hlEntry = recentLow + LH_HL_OFFSET;
        if (hlEntry < currentPrice) {
          const hlTp = hlEntry * (1 + MIN_TP_RATIO);
          const hlMargin = baseMargin;
          const hlPositionValue = hlMargin * leverage;
          const hlQuantity = Math.floor((hlPositionValue / hlEntry) * 1000) / 1000;
          orders.push({
            side: 'BUY',
            positionSide: 'LONG',
            price: hlEntry,
            quantity: hlQuantity,
            stopLoss: 0,  // 由 placeOrders 用 entryPrice ± 200 重算
            takeProfit: hlTp,
            margin: hlMargin,
            timeframe: '1h',
            source: 'HL',
          });
          console.log(`[TowerScheduler] HL不破单: BUY @ ${hlEntry.toFixed(0)} (最近LL=${recentLow.toFixed(0)} + ${LH_HL_OFFSET}), TP=${hlTp.toFixed(0)}`);
        }
      }
    } catch (e) {
      console.error(`[TowerScheduler] LH/HL 计算失败:`, e);
    }
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
      console.log(`[TowerScheduler] placeOrders input: side=${order.side} entry=${order.price} SL=${order.stopLoss} TP=${order.takeProfit}`);
      // 按 OB 面板风格取整（尾数 0/5，BUY 向上，SELL 向下）
      // 先"让点位"：BUY +30（出价更高），SELL -30（要价更低），更快成交
      const adjustedEntry = order.side === 'BUY' ? order.price + ENTRY_OFFSET : order.price - ENTRY_OFFSET;
      const entryPrice = exchangeAdapter.roundToOBEntry(adjustedEntry, order.side);

      // SL 直接从 entryPrice 算 ± 200 点（不再用 block.entry ± 200，避免 offset/rounding 让距离飘到 230+）
      // 同步重新取整保持尾数 0/5
      const adjustedSL = order.side === 'BUY' ? entryPrice - MAX_SL_DISTANCE : entryPrice + MAX_SL_DISTANCE;
      const slPrice = exchangeAdapter.roundToOBEntry(adjustedSL, order.side);

      const tpPrice = exchangeAdapter.roundToOBEntry(order.takeProfit, order.side);

      // 格式: ict_tower_{级别}_{ICT种类}_{点位}
      // 例如: ict_tower_4h_OB_95000 (21字符,Binance限制<36)
      const priceStr = entryPrice.toString();
      const clientOrderId = `ict_tower_${order.timeframe}_${order.source}_${priceStr}`;

      // 1. 下入场单（限价单）
      const entryResult = await exchangeAdapter.placeLimitOrder(exchange, exchangeConfig, {
        symbol,
        side: order.side,
        positionSide: order.positionSide,
        quantity: order.quantity,
        price: entryPrice,
        clientOrderId,
      });

      if (!entryResult.success) {
        errors.push(`入场 ${order.side} @ ${entryPrice}: ${entryResult.error}`);
        continue;
      }

      console.log(`[TowerScheduler] 入场单: ${order.side} @ ${entryPrice}, 保证金=${order.margin}, 数量=${order.quantity.toFixed(3)}, SL=${slPrice.toFixed(1)}, TP=${tpPrice.toFixed(1)}`);

      // 平仓方向
      const closeSide = order.side === 'BUY' ? 'SELL' : 'BUY';

      // 2. 下止损单（STOP_MARKET）
      await delay(100);
      let slResult = await exchangeAdapter.placeStopLossOrder(exchange, exchangeConfig, {
        symbol,
        side: closeSide,
        positionSide: order.positionSide,
        quantity: order.quantity,
        stopPrice: slPrice,
        clientOrderId: `${clientOrderId}_sl`,
      });

      // 如果止损单失败（立即触发：当前价已超过 200 点 SL 范围），改用 10 点紧贴止损
      if (!slResult.success && slResult.error?.includes('would immediately trigger')) {
        console.warn(`[TowerScheduler] 200点 SL 会立即触发，改用 10 点紧贴保护性止损`);

        // 用一个 10 点的紧贴止损（避免千分之3 对高价币 > 200 的问题）
        const rawProtectiveSL = order.side === 'BUY'
          ? entryPrice - 10
          : entryPrice + 10;
        const protectiveStopLoss = exchangeAdapter.roundToOBEntry(rawProtectiveSL, order.side);

        slResult = await exchangeAdapter.placeStopLossOrder(exchange, exchangeConfig, {
          symbol,
          side: closeSide,
          positionSide: order.positionSide,
          quantity: order.quantity,
          stopPrice: protectiveStopLoss,
          clientOrderId: `${clientOrderId}_sl`,
        });

        if (!slResult.success) {
          console.error(`[TowerScheduler] 保护性止损单也失败: ${slResult.error}`);
        } else {
          console.log(`[TowerScheduler] 保护性止损单成功: ${protectiveStopLoss.toFixed(1)} (紧贴10点)`);
        }
      } else if (!slResult.success) {
        console.warn(`[TowerScheduler] 止损单失败: ${slResult.error}`);
      } else {
        console.log(`[TowerScheduler] 止损单下单成功: ${clientOrderId}_sl`);
      }

      // 止盈单不在此处下，等入场单成交后由 orderMonitor 下单

      success++;

      // 保存待处理订单（用于成交后补下追踪止盈）
      console.log(`[TowerScheduler] savePendingOrder: clientOrderId=${clientOrderId} entry=${order.price} SL=${order.stopLoss} TP=${order.takeProfit}`);
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

    // 检查是否有 ict_protect_xxx 保护止损单
    const hasProtectOrder = openOrders.some(o =>
      o.positionSide === positionSide &&
      o.clientOrderId?.startsWith('ict_protect_')
    );

    // 如果没有保护单，下一个 200 点保护止损
    if (!hasProtectOrder) {
      const stopLoss = positionSide === 'LONG'
        ? entryPrice - 200  // 多单：入场价 - 200
        : entryPrice + 200; // 空单：入场价 + 200

      console.log(`[TowerScheduler] ${symbol} ${positionSide} 缺少保护止损，下达保护单: 入场=${entryPrice}, 止损=${stopLoss}`);

      await placeRepairOrder(apiConfig, {
        symbol,
        positionSide,
        quantity,
        type: 'STOP_MARKET',
        stopPrice: stopLoss,
        isProtect: true,  // 标记为保护单
      });
    }
  }
}

/**
 * 根据入场价和方向计算止损止盈
 * 止损：固定 200 点（与 placeOrders / 保护单保持一致）
 */
function calculateSlTpForPosition(
  entryPrice: number,
  positionSide: 'LONG' | 'SHORT'
): { stopLoss: number; takeProfit: number } {
  if (positionSide === 'LONG') {
    // 多单：止损在下方 200 点，止盈在上方 (2.5%)
    return {
      stopLoss: entryPrice - MAX_SL_DISTANCE,
      takeProfit: entryPrice * (1 + MIN_TP_RATIO),
    };
  } else {
    // 空单：止损在上方 200 点，止盈在下方 (2.5%)
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
    isProtect?: boolean;  // 是否为保护单
  }
): Promise<void> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const closeSide = params.positionSide === 'LONG' ? 'SELL' : 'BUY';
  const timestamp = Date.now();

  // 生成订单 ID：保护单用 ict_protect_，普通修复单用 ict_repair_
  let clientOrderId: string;
  if (params.isProtect) {
    // 格式: ict_protect_{方向}_{入场价}
    // 例如: ict_protect_L_79500
    const sideShort = params.positionSide === 'LONG' ? 'L' : 'S';
    const entryPriceStr = Math.round(params.stopPrice).toString();  // 注意这里是止损价反推入场价
    clientOrderId = `ict_protect_${sideShort}_${entryPriceStr}`;
    console.log(`[TowerScheduler] 下达保护止损单: ${clientOrderId}, 止损=${params.stopPrice}`);
  } else {
    // 格式: ict_repair_{方向}_{类型}_{点位}
    // 例如: ict_repair_L_SL_94800 (22字符)
    const sideShort = params.positionSide === 'LONG' ? 'L' : 'S';
    const typeShort = params.type === 'STOP_MARKET' ? 'SL' : 'TP';
    const priceStr = Math.round(params.stopPrice).toString();
    clientOrderId = `ict_repair_${sideShort}_${typeShort}_${priceStr}`;
  }

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
