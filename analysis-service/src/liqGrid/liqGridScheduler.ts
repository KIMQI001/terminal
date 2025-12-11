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
} from './liqGridManagementStore';
import { getBinanceApiConfig } from '../order/apiConfigReader';
import { fetchLiquidation, LiquidationLevel } from '../data/liquidationClient';
import { sendDingtalkMarkdown } from '../notification/dingtalk';
import crypto from 'crypto';

// 调度器状态
let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

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
    // 获取用户 API 配置
    const apiConfig = getBinanceApiConfig(management.userId);
    if (!apiConfig) {
      console.error(`[LiqGridScheduler] 用户 ${management.userId} 没有 API 配置`);
      addRecord({
        managementId: management.id,
        buyCount: 0,
        sellCount: 0,
        totalMargin: 0,
        success: false,
        skipped: false,
        errorMessage: '没有 API 配置',
      });
      updateRunTime(management.id);
      return;
    }

    // 1. 检查是否有持仓（有持仓时跳过，避免取消止盈单）
    const positionsResult = await getPositions(apiConfig, management.symbol);
    if (positionsResult.success && positionsResult.positions && positionsResult.positions.length > 0) {
      const positions = positionsResult.positions.filter(p => Math.abs(p.positionAmt) >= 0.001);
      if (positions.length > 0) {
        console.log(`[LiqGridScheduler] 有持仓，跳过更新: ${positions.map(p => `${p.positionSide} ${p.positionAmt}`).join(', ')}`);
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
    }

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

    // 3. 取消现有 liq_grid 订单
    const cancelResult = await cancelLiqGridOrders(apiConfig, management.symbol);
    if (!cancelResult.success) {
      console.error(`[LiqGridScheduler] 取消订单失败: ${cancelResult.error}`);
    }

    // 等待订单取消完成
    await delay(500);

    // 4. 设置杠杆
    await setLeverage(apiConfig, management.symbol, management.leverage);

    // 5. 计算网格订单
    const orders = calculateGridOrders(liqData, management);
    if (orders.length === 0) {
      console.log('[LiqGridScheduler] 没有符合条件的清算峰值');
      addRecord({
        managementId: management.id,
        buyCount: 0,
        sellCount: 0,
        totalMargin: 0,
        success: true,
        skipped: true,
        errorMessage: '没有符合条件的清算峰值',
      });
      updateRunTime(management.id);
      return;
    }

    // 6. 下单
    const result = await placeOrders(apiConfig, management.symbol, orders);

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
      await sendDingtalkMarkdown(
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
 */
function calculateGridOrders(
  liqData: { longPeaks: LiquidationLevel[]; shortPeaks: LiquidationLevel[]; currentPrice: number },
  management: LiqGridManagementConfig
): GridOrder[] {
  const { longPeaks, shortPeaks, currentPrice } = liqData;
  const { baseMargin, marginPerLevel, leverage } = management;

  const orders: GridOrder[] = [];

  // 多头清算峰 → 开多单（抄底）→ 止盈设在空头清算峰（最近的）
  const lowestShortPeak = shortPeaks.length > 0
    ? shortPeaks.reduce((min, p) => (p.price < min.price ? p : min), shortPeaks[0])
    : null;

  // 多单：按价格从高到低排序（离当前价近的先）
  const sortedLongPeaks = [...longPeaks].sort((a, b) => b.price - a.price);
  for (let i = 0; i < sortedLongPeaks.length; i++) {
    const peak = sortedLongPeaks[i];
    const tpPrice = lowestShortPeak?.price || peak.price * 1.02;
    const margin = baseMargin + marginPerLevel * i;
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
    const margin = baseMargin + marginPerLevel * i;
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
 * 下单
 */
async function placeOrders(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string,
  orders: GridOrder[]
): Promise<{ success: number; errors: string[] }> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  let success = 0;
  const errors: string[] = [];
  const precision = getPrecision(symbol);

  // analysis-service 地址
  const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || 'http://127.0.0.1:3002';

  for (const order of orders) {
    try {
      const timestamp = Date.now();
      const priceStr = order.entryPrice.toFixed(precision.price).replace('.', '');
      const clientOrderId = `liq_grid_${order.side.toLowerCase()}_${priceStr}_${timestamp}`;

      // 下限价单
      const entryParams: Record<string, string | number> = {
        symbol,
        side: order.side,
        positionSide: order.positionSide,
        type: 'LIMIT',
        quantity: order.quantity.toFixed(precision.quantity),
        price: order.entryPrice.toFixed(precision.price),
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
        errors.push(`${order.side} @ ${order.entryPrice}: ${data.msg || entryResponse.status}`);
        continue;
      }

      console.log(`[LiqGridScheduler] 入场单: ${order.side} @ ${order.entryPrice}, 保证金=${order.margin}, 数量=${order.quantity.toFixed(precision.quantity)}, TP=${order.tpPrice.toFixed(precision.price)}`);

      // 保存待处理订单（用于成交后下止盈单）
      await savePendingOrder({
        clientOrderId,
        symbol,
        side: order.side,
        positionSide: order.positionSide,
        quantity: order.quantity,
        entryPrice: order.entryPrice,
        stopLoss: 0,  // 无止损
        takeProfit: order.tpPrice,
      });

      success++;

      // 延迟避免请求过快
      await delay(100);
    } catch (error) {
      errors.push(`${order.side} @ ${order.entryPrice}: ${error instanceof Error ? error.message : '未知错误'}`);
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
  const { addPendingOrder } = await import('../order/pendingOrderStore');
  addPendingOrder(params);
}

/**
 * 获取持仓
 */
async function getPositions(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string
): Promise<{ success: boolean; positions?: Array<{ positionSide: string; positionAmt: number }> }> {
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

    if (!response.ok) return { success: false };

    const positions = await response.json() as Array<{
      symbol: string;
      positionSide: string;
      positionAmt: string;
    }>;

    return {
      success: true,
      positions: positions
        .filter(p => p.symbol === symbol)
        .map(p => ({
          positionSide: p.positionSide,
          positionAmt: parseFloat(p.positionAmt),
        })),
    };
  } catch {
    return { success: false };
  }
}

/**
 * 取消所有 liq_grid 订单
 */
async function cancelLiqGridOrders(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  try {
    // 获取当前挂单
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString, apiConfig.apiSecret);

    const response = await fetch(
      `${baseUrl}/fapi/v1/openOrders?${queryString}&signature=${signature}`,
      { headers: { 'X-MBX-APIKEY': apiConfig.apiKey } }
    );

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const orders = await response.json() as Array<{ orderId: number; clientOrderId: string }>;
    const liqGridOrders = orders.filter(o => o.clientOrderId?.startsWith('liq_grid'));

    if (liqGridOrders.length === 0) {
      return { success: true };
    }

    // 逐个取消
    let canceledCount = 0;
    for (const order of liqGridOrders) {
      const cancelTimestamp = Date.now();
      const cancelQueryString = `symbol=${symbol}&orderId=${order.orderId}&timestamp=${cancelTimestamp}`;
      const cancelSignature = generateSignature(cancelQueryString, apiConfig.apiSecret);

      const cancelResponse = await fetch(`${baseUrl}/fapi/v1/order`, {
        method: 'DELETE',
        headers: {
          'X-MBX-APIKEY': apiConfig.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `${cancelQueryString}&signature=${cancelSignature}`,
      });

      if (cancelResponse.ok) canceledCount++;
      await delay(50);
    }

    console.log(`[LiqGridScheduler] 取消了 ${canceledCount}/${liqGridOrders.length} 个订单`);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络错误',
    };
  }
}

/**
 * 设置杠杆
 */
async function setLeverage(
  apiConfig: { apiKey: string; apiSecret: string; isTestnet: boolean },
  symbol: string,
  leverage: number
): Promise<boolean> {
  const baseUrl = apiConfig.isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  try {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`;
    const signature = generateSignature(queryString, apiConfig.apiSecret);

    const response = await fetch(`${baseUrl}/fapi/v1/leverage`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiConfig.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${queryString}&signature=${signature}`,
    });

    if (response.ok) {
      console.log(`[LiqGridScheduler] 杠杆设置成功: ${symbol} ${leverage}x`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 生成签名
 */
function generateSignature(queryString: string, apiSecret: string): string {
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
