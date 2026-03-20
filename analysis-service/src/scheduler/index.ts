/**
 * 任务调度器
 * 定时分析守塔策略挂单 + AI 分析
 */

import cron from 'node-cron';
import { config } from '../config';
import { fetchLiquidation } from '../data/liquidationClient';
import { analyzeMultiTimeframe } from '../analysis/mtfAnalyzer';
import { generateMTFSignal } from '../analysis/aiAnalyzer';
import { analyzeOrdersByRules, OrderAnalysis } from '../analysis/orderAnalyzer';
import { getOpenOrders } from '../order/exchangeAdapter';
import { getFirstBinanceApiConfig } from '../order/apiConfigReader';
import { sendDingtalkMarkdown } from '../notification/dingtalk';

/**
 * 启动调度器
 */
export function startScheduler(): void {
  console.log('═══════════════════════════════════════');
  console.log('🚀 订单分析服务启动');
  console.log(`📊 监控: ${config.watchlist.map(w => w.symbol).join(', ')}`);
  console.log(`⏰ 间隔: ${config.schedule.interval}`);
  console.log('═══════════════════════════════════════');

  // 启动定时任务
  cron.schedule(config.schedule.interval, async () => {
    console.log(`\n[${new Date().toISOString()}] 开始订单分析...`);
    await runOrderAnalysis();
  });

  // 立即执行一次
  console.log('\n[启动] 执行首次订单分析...');
  runOrderAnalysis();
}

/**
 * 订单分析
 */
async function runOrderAnalysis(): Promise<void> {
  for (const item of config.watchlist) {
    await analyzeSymbolOrders(item.symbol);
    await sleep(2000);
  }
}

/**
 * 分析单个交易对的订单
 */
async function analyzeSymbolOrders(symbol: string): Promise<void> {
  const key = `${symbol}@ANALYSIS`;
  console.log(`\n[${key}] 开始分析...`);

  try {
    // 获取配置
    const result = getFirstBinanceApiConfig();
    if (!result) {
      console.log(`[${key}] 未找到 Binance API 配置`);
      return;
    }

    const exchangeConfig = {
      apiKey: result.config.apiKey,
      apiSecret: result.config.apiSecret,
      isTestnet: result.config.isTestnet,
    };

    // 获取挂单
    const ordersResult = await getOpenOrders('binance', exchangeConfig, symbol);
    if (!ordersResult.success || !ordersResult.orders) {
      console.log(`[${key}] 获取订单失败: ${ordersResult.error}`);
      return;
    }

    // 过滤守塔的订单
    const towerOrders = ordersResult.orders.filter(o =>
      o.clientOrderId && o.clientOrderId.startsWith('ict_tower')
    );

    // 获取当前价格
    const { getCurrentPrice } = await import('../order/binanceOrderApi');
    const currentPrice = await getCurrentPrice(result.config, symbol);
    if (!currentPrice) {
      console.log(`[${key}] 获取价格失败`);
      return;
    }
    console.log(`[${key}] 当前价格: $${currentPrice}`);

    // 获取 HTF 分析 + 清算数据
    const baseCoin = symbol.replace('USDC', '').replace('USDT', '');
    const liquidation = await fetchLiquidation(baseCoin, '1d');
    const mtfResult = await analyzeMultiTimeframe(symbol, liquidation);

    console.log(`[${key}] HTF: ${mtfResult.htf.bias}, 对齐度: ${mtfResult.alignment}%`);
    console.log(`[${key}] 4D: ${mtfResult.htf.fourDay.trend} | 1D: ${mtfResult.htf.daily.trend} | 4H: ${mtfResult.htf.h4.trend}`);

    // 调用 AI 分析
    console.log(`[${key}] 调用 AI 分析...`);
    const aiSignal = await generateMTFSignal(mtfResult, liquidation);

    // 规则分析
    const ruleAnalysis = analyzeOrdersByRules(
      towerOrders,
      currentPrice,
      symbol,
      mtfResult.htf.bias,
      mtfResult.alignment,
      mtfResult.ltf.entry?.type || null
    );

    // 格式化输出
    const message = formatAnalysisMessage(
      symbol,
      currentPrice,
      towerOrders,
      mtfResult,
      aiSignal,
      ruleAnalysis
    );

    console.log(`\n[${key}] ========== AI 分析结果 ==========`);
    console.log(aiSignal ? aiSignal.summary || 'AI 分析完成' : 'AI 分析失败');
    if (aiSignal?.recommendations?.length) {
      for (const rec of aiSignal.recommendations) {
        console.log(`推荐 ${rec.rank}: ${rec.direction} @ $${rec.entryZone.low.toFixed(0)}-$ ${rec.entryZone.high.toFixed(0)}`);
        console.log(`  条件: ${rec.entryCondition}`);
        console.log(`  SL: $${rec.stopLoss.price.toFixed(2)} | TP: $${rec.takeProfit.price.toFixed(2)} | RR: ${rec.riskReward.toFixed(1)}`);
      }
    }
    console.log(`[${key}] =====================================\n`);

    // 发送钉钉消息
    await sendDingtalkMarkdown(`${symbol} AI 分析`, message);

  } catch (error) {
    console.error(`[${key}] 分析失败:`, error);
  }
}

/**
 * 格式化分析消息
 */
function formatAnalysisMessage(
  symbol: string,
  currentPrice: number,
  towerOrders: any[],
  mtfResult: any,
  aiSignal: any,
  ruleAnalysis: OrderAnalysis
): string {
  const lines: string[] = [];

  // 标题
  lines.push(`## ${symbol} AI 分析`);
  lines.push(`**当前价格**: $${currentPrice.toFixed(2)}`);
  lines.push('');

  // HTF 状态
  lines.push('### HTF 状态');
  lines.push(`- 4D: ${mtfResult.htf.fourDay.trend} | 1D: ${mtfResult.htf.daily.trend} | 4H: ${mtfResult.htf.h4.trend}`);
  lines.push(`- 偏向: ${mtfResult.htf.bias} | 对齐度: ${mtfResult.alignment}%`);
  lines.push('');

  // P/D 区间（如果有的话）
  if (aiSignal?.keyLevels?.pdHigh && aiSignal?.keyLevels?.pdLow) {
    lines.push('### P/D 区间');
    lines.push(`- P (高估): $${aiSignal.keyLevels.pdHigh.toFixed(2)}`);
    lines.push(`- D (低估): $${aiSignal.keyLevels.pdLow.toFixed(2)}`);
    lines.push(`- 当前价格偏离 D 位: ${(((currentPrice - aiSignal.keyLevels.pdLow) / aiSignal.keyLevels.pdLow) * 100).toFixed(2)}%`);
    lines.push('');
  }

  // AI 推荐
  if (aiSignal?.summary) {
    lines.push('### AI 分析结论');
    lines.push(aiSignal.summary);
    lines.push('');
  }

  if (aiSignal?.recommendations?.length) {
    lines.push('### 最佳入场推荐');
    for (const rec of aiSignal.recommendations) {
      lines.push(`**推荐 ${rec.rank}: ${rec.direction.toUpperCase()}**`);
      lines.push(`- 入场区间: $${rec.entryZone.low.toFixed(0)} - $${rec.entryZone.high.toFixed(0)}`);
      lines.push(`- 入场条件: ${rec.entryCondition}`);
      lines.push(`- 止损: $${rec.stopLoss.price.toFixed(2)} (${rec.stopLoss.reason})`);
      lines.push(`- 止盈: $${rec.takeProfit.price.toFixed(2)} (${rec.takeProfit.reason})`);
      lines.push(`- RR: ${rec.riskReward.toFixed(1)}`);
      if (rec.htfBias) lines.push(`- HTF: ${rec.htfBias}`);
      if (rec.ictConfirmation?.length) lines.push(`- ICT 确认: ${rec.ictConfirmation.join(', ')}`);
      lines.push('');
    }
  } else {
    lines.push('### 入场推荐');
    lines.push('暂无符合条件的入场点');
    lines.push('');
  }

  // 关键支撑阻力
  if (aiSignal?.keyLevels) {
    const levels = aiSignal.keyLevels;
    if (levels.support?.length || levels.resistance?.length) {
      lines.push('### 关键价位');
      if (levels.support?.length) lines.push(`- 支撑: ${levels.support.map((s: number) => `$${s.toFixed(0)}`).join(', ')}`);
      if (levels.resistance?.length) lines.push(`- 阻力: ${levels.resistance.map((r: number) => `$${r.toFixed(0)}`).join(', ')}`);
      lines.push('');
    }
  }

  // 当前守塔订单
  lines.push('### 当前守塔订单');
  if (towerOrders.length === 0) {
    lines.push('无守塔订单');
  } else {
    const sorted = [...towerOrders].sort((a: any, b: any) => a.price - b.price);
    for (const o of sorted) {
      const side = o.side === 'BUY' ? '多' : '空';
      const pos = o.positionSide === 'LONG' ? '多' : o.positionSide === 'SHORT' ? '空' : '双向';
      const dist = o.price > currentPrice
        ? `+${((o.price - currentPrice) / currentPrice * 100).toFixed(2)}%`
        : `${((o.price - currentPrice) / currentPrice * 100).toFixed(2)}%`;
      lines.push(`- ${side}${pos}: $${o.price.toFixed(2)} (${dist})`);
    }
  }
  lines.push('');

  // 规则分析建议
  lines.push('---');
  lines.push(`**规则建议**: ${ruleAnalysis.recommendation?.action} - ${ruleAnalysis.recommendation?.reason}`);

  return lines.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
