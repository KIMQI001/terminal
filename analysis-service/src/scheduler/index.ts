/**
 * 任务调度器
 * 定时执行 ICT + AI 分析
 */

import cron from 'node-cron';
import { config } from '../config';
import { fetchKlines, Timeframe } from '../data/klineClient';
import { fetchLiquidation } from '../data/liquidationClient';
import { analyzeICT } from '../analysis/ictAnalyzer';
import { generateTradeSignal, getCallStats } from '../analysis/aiAnalyzer';
import { sendDingtalkMarkdown } from '../notification/dingtalk';
import { formatSignalMessage } from '../notification/formatter';
import { saveSignal, hasDuplicatePendingSignal } from '../signals/signalStore';

// 上次推送的信号缓存（防止重复推送）
const lastSignals: Map<string, string> = new Map();

/**
 * 启动调度器
 */
export function startScheduler(): void {
  console.log('═══════════════════════════════════════');
  console.log('🚀 分析服务调度器启动');
  console.log(`📊 监控: ${config.watchlist.map(w => w.symbol).join(', ')}`);
  console.log(`⏰ 间隔: ${config.schedule.interval}`);
  console.log(`🤖 AI: ${config.ai.provider} (${config.ai.model})`);
  console.log('═══════════════════════════════════════');

  // 启动定时任务
  cron.schedule(config.schedule.interval, async () => {
    console.log(`\n[${new Date().toISOString()}] 开始分析周期...`);

    for (const item of config.watchlist) {
      for (const timeframe of item.timeframes) {
        await analyzeSymbol(item.symbol, timeframe as Timeframe);
        // 每个分析间隔 2 秒，避免 API 限流
        await sleep(2000);
      }
    }

    const stats = getCallStats();
    console.log(`[分析完成] AI 调用: 本小时 ${stats.hourly}/${config.ai.maxCallsPerHour}, 今日 ${stats.daily}/${config.ai.maxCallsPerDay}`);
  });

  // 立即执行一次
  console.log('\n[启动] 执行首次分析...');
  runInitialAnalysis();
}

/**
 * 首次分析
 */
async function runInitialAnalysis(): Promise<void> {
  for (const item of config.watchlist) {
    for (const timeframe of item.timeframes) {
      await analyzeSymbol(item.symbol, timeframe as Timeframe);
      await sleep(2000);
    }
  }
}

/**
 * 分析单个交易对
 */
async function analyzeSymbol(symbol: string, timeframe: Timeframe): Promise<void> {
  const key = `${symbol}@${timeframe}`;
  console.log(`[${key}] 开始分析...`);

  try {
    // 1. 获取 K线数据
    const candles = await fetchKlines(symbol, timeframe, 500);
    if (candles.length < 100) {
      console.log(`[${key}] K线数据不足: ${candles.length}`);
      return;
    }

    // 2. 获取清算数据
    const baseCoin = symbol.replace('USDC', '').replace('USDT', '');
    const liquidation = await fetchLiquidation(baseCoin, '1d');

    // 3. ICT 分析
    const ictResult = analyzeICT(candles, symbol, timeframe);
    console.log(`[${key}] ICT 分析完成 - 趋势: ${ictResult.trend}, Swings: ${ictResult.swingPoints.length}, FVGs: ${ictResult.fvgs.length}, OTEs: ${ictResult.oteZones.length}`);

    // 4. AI 分析
    const signal = await generateTradeSignal(ictResult, liquidation);
    if (!signal) {
      console.log(`[${key}] AI 分析跳过或失败`);
      return;
    }

    console.log(`[${key}] AI 分析完成 - 方向: ${signal.direction}, 置信度: ${signal.confidence}`);

    // 5. 过滤低置信度信号
    if (signal.direction === 'neutral') {
      console.log(`[${key}] 建议观望，不推送`);
      return;
    }

    if (signal.confidence === 'low') {
      console.log(`[${key}] 低置信度信号，不推送`);
      return;
    }

    // 6. 检查是否重复信号（内存缓存 + 数据库双重检查）
    const signalHash = `${signal.direction}-${signal.entry.price.toFixed(0)}-${signal.stopLoss.price.toFixed(0)}`;
    if (lastSignals.get(key) === signalHash) {
      console.log(`[${key}] 重复信号（缓存），不推送`);
      return;
    }

    // 检查数据库中是否已有相似的待处理信号
    if (hasDuplicatePendingSignal(symbol, timeframe, signal.direction, signal.entry.price)) {
      console.log(`[${key}] 重复信号（数据库），不推送`);
      return;
    }

    lastSignals.set(key, signalHash);

    // 7. 保存信号到数据库
    try {
      const signalId = saveSignal(signal, symbol, timeframe);
      console.log(`[${key}] 信号已保存: ${signalId}`);
    } catch (dbError) {
      console.error(`[${key}] 信号保存失败:`, dbError);
      // 即使保存失败也继续推送
    }

    // 8. 推送钉钉
    const message = formatSignalMessage(signal, ictResult);
    const sent = await sendDingtalkMarkdown(`${symbol} ${timeframe} 信号`, message);
    console.log(`[${key}] 钉钉推送: ${sent ? '成功' : '失败'}`);

  } catch (error) {
    console.error(`[${key}] 分析失败:`, error);
  }
}

/**
 * 睡眠函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
