/**
 * 信号跟踪器
 * 每分钟检查信号状态，更新入场/止损/止盈
 */

import cron from 'node-cron';
import { SignalRecord } from '../db';
import {
  getPendingSignals,
  getEnteredSignals,
  updateSignalStatus,
  expireOldSignals,
} from './signalStore';
import { fetchKlines } from '../data/klineClient';
import { sendDingtalkMarkdown } from '../notification/dingtalk';

// 价格缓存（避免重复请求）
const priceCache: Map<string, { price: number; timestamp: number }> = new Map();
const CACHE_TTL = 30 * 1000; // 30秒缓存

/**
 * 获取当前价格
 */
async function getCurrentPrice(symbol: string): Promise<number | null> {
  const cacheKey = symbol;
  const cached = priceCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.price;
  }

  try {
    // 获取最新的 1m K线作为当前价格
    const candles = await fetchKlines(symbol, '5m', 1);
    if (candles.length > 0) {
      const price = candles[candles.length - 1].close;
      priceCache.set(cacheKey, { price, timestamp: Date.now() });
      return price;
    }
  } catch (error) {
    console.error(`[SignalTracker] 获取 ${symbol} 价格失败:`, error);
  }

  return null;
}

/**
 * 检查多头是否触及止损
 */
function hitStopLossLong(signal: SignalRecord, currentPrice: number): boolean {
  return currentPrice <= signal.stopLoss;
}

/**
 * 检查空头是否触及止损
 */
function hitStopLossShort(signal: SignalRecord, currentPrice: number): boolean {
  return currentPrice >= signal.stopLoss;
}

/**
 * 检查多头是否触及止盈
 */
function hitTakeProfitLong(signal: SignalRecord, currentPrice: number): boolean {
  if (signal.takeProfits.length === 0) return false;
  const firstTP = signal.takeProfits[0];
  return currentPrice >= firstTP;
}

/**
 * 检查空头是否触及止盈
 */
function hitTakeProfitShort(signal: SignalRecord, currentPrice: number): boolean {
  if (signal.takeProfits.length === 0) return false;
  const firstTP = signal.takeProfits[0];
  return currentPrice <= firstTP;
}

/**
 * 计算盈亏百分比
 */
function calculatePnL(signal: SignalRecord, exitPrice: number): number {
  if (signal.direction === 'long') {
    return ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100;
  } else {
    return ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100;
  }
}

/**
 * 计算实际风险回报比
 */
function calculateActualRR(signal: SignalRecord, exitPrice: number): number {
  const risk = Math.abs(signal.entryPrice - signal.stopLoss);
  if (risk === 0) return 0;

  const reward =
    signal.direction === 'long'
      ? exitPrice - signal.entryPrice
      : signal.entryPrice - exitPrice;

  return reward / risk;
}

/**
 * 检查待入场的信号
 */
async function checkPendingSignals(): Promise<void> {
  const pending = getPendingSignals();
  if (pending.length === 0) return;

  console.log(`[SignalTracker] 检查 ${pending.length} 个待入场信号...`);

  for (const signal of pending) {
    const currentPrice = await getCurrentPrice(signal.symbol);
    if (currentPrice === null) continue;

    let shouldEnter = false;

    if (signal.direction === 'long') {
      // 多头：价格跌到或低于入场价时入场
      shouldEnter = currentPrice <= signal.entryPrice;
    } else {
      // 空头：价格涨到或高于入场价时入场
      shouldEnter = currentPrice >= signal.entryPrice;
    }

    if (shouldEnter) {
      console.log(
        `[SignalTracker] 信号入场: ${signal.id} (${signal.symbol}@${signal.timeframe} ${signal.direction}) @ $${currentPrice}`
      );

      updateSignalStatus(signal.id, 'entered', {
        enteredAt: new Date(),
      });

      // 发送入场通知
      await sendDingtalkMarkdown(
        '信号入场通知',
        `### 信号已入场\n\n` +
          `- **交易对**: ${signal.symbol}\n` +
          `- **周期**: ${signal.timeframe}\n` +
          `- **方向**: ${signal.direction === 'long' ? '做多 📈' : '做空 📉'}\n` +
          `- **入场价**: $${currentPrice.toFixed(2)}\n` +
          `- **止损**: $${signal.stopLoss.toFixed(2)}\n` +
          `- **止盈**: $${signal.takeProfits[0]?.toFixed(2) || 'N/A'}\n` +
          `- **预期盈亏比**: ${signal.riskReward.toFixed(2)}\n`
      );
    }
  }
}

/**
 * 检查已入场的信号
 */
async function checkEnteredSignals(): Promise<void> {
  const entered = getEnteredSignals();
  if (entered.length === 0) return;

  console.log(`[SignalTracker] 检查 ${entered.length} 个已入场信号...`);

  for (const signal of entered) {
    const currentPrice = await getCurrentPrice(signal.symbol);
    if (currentPrice === null) continue;

    const isLong = signal.direction === 'long';

    // 检查止损
    const hitSL = isLong
      ? hitStopLossLong(signal, currentPrice)
      : hitStopLossShort(signal, currentPrice);

    if (hitSL) {
      const pnl = calculatePnL(signal, signal.stopLoss);
      console.log(
        `[SignalTracker] 信号止损: ${signal.id} @ $${signal.stopLoss} (PnL: ${pnl.toFixed(2)}%)`
      );

      updateSignalStatus(signal.id, 'stopped', {
        exitedAt: new Date(),
        exitPrice: signal.stopLoss,
        exitReason: '触及止损',
        actualRR: -1,
        pnlPercent: pnl,
      });

      // 发送止损通知
      await sendDingtalkMarkdown(
        '止损通知',
        `### 信号已止损 ❌\n\n` +
          `- **交易对**: ${signal.symbol}\n` +
          `- **周期**: ${signal.timeframe}\n` +
          `- **方向**: ${signal.direction === 'long' ? '做多' : '做空'}\n` +
          `- **入场价**: $${signal.entryPrice.toFixed(2)}\n` +
          `- **止损价**: $${signal.stopLoss.toFixed(2)}\n` +
          `- **盈亏**: ${pnl.toFixed(2)}%\n`
      );

      continue;
    }

    // 检查止盈
    const hitTP = isLong
      ? hitTakeProfitLong(signal, currentPrice)
      : hitTakeProfitShort(signal, currentPrice);

    if (hitTP && signal.takeProfits.length > 0) {
      const tp = signal.takeProfits[0];
      const pnl = calculatePnL(signal, tp);
      const actualRR = calculateActualRR(signal, tp);

      console.log(
        `[SignalTracker] 信号止盈: ${signal.id} @ $${tp} (PnL: ${pnl.toFixed(2)}%, RR: ${actualRR.toFixed(2)})`
      );

      updateSignalStatus(signal.id, 'profit', {
        exitedAt: new Date(),
        exitPrice: tp,
        exitReason: '触及止盈',
        actualRR,
        pnlPercent: pnl,
      });

      // 发送止盈通知
      await sendDingtalkMarkdown(
        '止盈通知',
        `### 信号已止盈 ✅\n\n` +
          `- **交易对**: ${signal.symbol}\n` +
          `- **周期**: ${signal.timeframe}\n` +
          `- **方向**: ${signal.direction === 'long' ? '做多' : '做空'}\n` +
          `- **入场价**: $${signal.entryPrice.toFixed(2)}\n` +
          `- **止盈价**: $${tp.toFixed(2)}\n` +
          `- **盈亏**: +${pnl.toFixed(2)}%\n` +
          `- **实际盈亏比**: ${actualRR.toFixed(2)}\n`
      );
    }
  }
}

/**
 * 运行一次跟踪检查
 */
async function runTrackingCycle(): Promise<void> {
  try {
    // 检查待入场信号
    await checkPendingSignals();

    // 检查已入场信号
    await checkEnteredSignals();

    // 标记过期信号
    expireOldSignals(24);
  } catch (error) {
    console.error('[SignalTracker] 跟踪周期出错:', error);
  }
}

/**
 * 启动信号跟踪器
 * 每分钟运行一次
 */
export function startSignalTracker(): void {
  console.log('[SignalTracker] 启动信号跟踪器 (每分钟检查)');

  // 每分钟执行一次
  cron.schedule('* * * * *', async () => {
    await runTrackingCycle();
  });

  // 立即执行一次
  runTrackingCycle();
}

/**
 * 手动触发一次跟踪
 */
export async function triggerTrackingCycle(): Promise<void> {
  await runTrackingCycle();
}
