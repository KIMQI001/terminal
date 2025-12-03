/**
 * 任务调度器
 * 定时执行 ICT + AI 分析
 * 支持两种模式：
 * - single: 独立周期分析（每个时间框架独立生成信号）
 * - mtf: 多时间框架综合分析（自上而下，只生成一个综合信号）
 */

import cron from 'node-cron';
import { config } from '../config';
import { fetchKlines, Timeframe } from '../data/klineClient';
import { fetchLiquidation } from '../data/liquidationClient';
import { analyzeICT } from '../analysis/ictAnalyzer';
import { generateTradeSignal, generateMTFSignal, getCallStats } from '../analysis/aiAnalyzer';
import { analyzeMultiTimeframe } from '../analysis/mtfAnalyzer';
import { sendDingtalkMarkdown } from '../notification/dingtalk';
import { formatSignalMessage, formatMTFSignalMessage } from '../notification/formatter';
import { saveSignal, hasDuplicatePendingSignal } from '../signals/signalStore';

// 上次推送的信号缓存（防止重复推送）
const lastSignals: Map<string, string> = new Map();

/**
 * 启动调度器
 */
export function startScheduler(): void {
  const mode = config.analysis.mode;

  console.log('═══════════════════════════════════════');
  console.log('🚀 分析服务调度器启动');
  console.log(`📊 监控: ${config.watchlist.map(w => w.symbol).join(', ')}`);
  console.log(`📈 模式: ${mode === 'mtf' ? '多时间框架综合分析 (MTF)' : '独立周期分析'}`);
  if (mode === 'mtf') {
    console.log(`   HTF: ${config.analysis.mtf.htf.join(', ')}`);
    console.log(`   MTF: ${config.analysis.mtf.mtf.join(', ')}`);
    console.log(`   LTF: ${config.analysis.mtf.ltf.join(', ')}`);
  }
  console.log(`⏰ 间隔: ${config.schedule.interval}`);
  console.log(`🤖 AI: ${config.ai.provider} (${config.ai.model || '默认模型'})`);
  console.log('═══════════════════════════════════════');

  // 启动定时任务
  cron.schedule(config.schedule.interval, async () => {
    console.log(`\n[${new Date().toISOString()}] 开始分析周期...`);
    await runAnalysis();
  });

  // 立即执行一次
  console.log('\n[启动] 执行首次分析...');
  runAnalysis();
}

/**
 * 执行分析（根据模式选择）
 */
async function runAnalysis(): Promise<void> {
  if (config.analysis.mode === 'mtf') {
    await runMTFAnalysis();
  } else {
    await runSingleAnalysis();
  }

  const stats = getCallStats();
  console.log(`[分析完成] AI 调用: 本小时 ${stats.hourly}/${config.ai.maxCallsPerHour}, 今日 ${stats.daily}/${config.ai.maxCallsPerDay}`);
}

/**
 * MTF 多时间框架综合分析
 */
async function runMTFAnalysis(): Promise<void> {
  for (const item of config.watchlist) {
    await analyzeSymbolMTF(item.symbol);
    await sleep(2000);
  }
}

/**
 * 单周期独立分析
 */
async function runSingleAnalysis(): Promise<void> {
  for (const item of config.watchlist) {
    for (const timeframe of config.analysis.singleTimeframes) {
      await analyzeSymbolSingle(item.symbol, timeframe as Timeframe);
      await sleep(2000);
    }
  }
}

/**
 * MTF 综合分析单个交易对
 */
async function analyzeSymbolMTF(symbol: string): Promise<void> {
  const key = `${symbol}@MTF`;
  console.log(`\n[${key}] 开始多时间框架分析...`);

  try {
    // 1. 执行 MTF 分析
    const mtfResult = await analyzeMultiTimeframe(symbol);
    console.log(`[${key}] MTF 分析完成:`);
    console.log(`  HTF 偏向: ${mtfResult.htf.bias}, 对齐: ${mtfResult.htf.aligned}`);
    console.log(`  MTF 确认: ${mtfResult.mtf.confirmed}`);
    console.log(`  对齐度: ${mtfResult.alignment}%, 可交易: ${mtfResult.tradeable}`);

    // 2. 如果不可交易，跳过
    if (!mtfResult.tradeable) {
      console.log(`[${key}] 时间框架未对齐或无入场机会，跳过 AI 分析`);
      return;
    }

    // 3. 获取清算数据
    const baseCoin = symbol.replace('USDC', '').replace('USDT', '');
    const liquidation = await fetchLiquidation(baseCoin, '1d');

    // 4. AI 生成综合信号
    const signal = await generateMTFSignal(mtfResult, liquidation);
    if (!signal) {
      console.log(`[${key}] AI 分析跳过或失败`);
      return;
    }

    console.log(`[${key}] AI 分析完成 - 方向: ${signal.direction}, 置信度: ${signal.confidence}`);

    // 5. 过滤信号
    if (signal.direction === 'neutral') {
      console.log(`[${key}] 建议观望，不推送`);
      return;
    }

    if (signal.confidence === 'low') {
      console.log(`[${key}] 低置信度信号，不推送`);
      return;
    }

    // 6. 检查重复信号
    const signalHash = `${signal.direction}-${signal.entry.price.toFixed(0)}-${signal.stopLoss.price.toFixed(0)}`;
    if (lastSignals.get(key) === signalHash) {
      console.log(`[${key}] 重复信号（缓存），不推送`);
      return;
    }

    if (hasDuplicatePendingSignal(symbol, 'mtf', signal.direction, signal.entry.price)) {
      console.log(`[${key}] 重复信号（数据库），不推送`);
      return;
    }

    lastSignals.set(key, signalHash);

    // 7. 保存信号到数据库
    try {
      const signalId = saveSignal(signal, symbol, 'mtf');
      console.log(`[${key}] 信号已保存: ${signalId}`);
    } catch (dbError) {
      console.error(`[${key}] 信号保存失败:`, dbError);
    }

    // 8. 推送钉钉
    const message = formatMTFSignalMessage(signal, mtfResult);
    const sent = await sendDingtalkMarkdown(`${symbol} MTF 综合信号`, message);
    console.log(`[${key}] 钉钉推送: ${sent ? '成功' : '失败'}`);

  } catch (error) {
    console.error(`[${key}] MTF 分析失败:`, error);
  }
}

/**
 * 单周期分析单个交易对
 */
async function analyzeSymbolSingle(symbol: string, timeframe: Timeframe): Promise<void> {
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

    // 6. 检查是否重复信号
    const signalHash = `${signal.direction}-${signal.entry.price.toFixed(0)}-${signal.stopLoss.price.toFixed(0)}`;
    if (lastSignals.get(key) === signalHash) {
      console.log(`[${key}] 重复信号（缓存），不推送`);
      return;
    }

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
