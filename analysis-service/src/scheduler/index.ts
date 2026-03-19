/**
 * 任务调度器
 * 定时分析守塔策略持仓
 */

import cron from 'node-cron';
import { config } from '../config';
import { fetchLiquidation } from '../data/liquidationClient';
import { analyzeMultiTimeframe } from '../analysis/mtfAnalyzer';
import { buildPositionAnalysisPrompt, analyzePositionsByRules, PositionAnalysis } from '../analysis/positionAnalyzer';
import { getPositions } from '../order/exchangeAdapter';
import { getFirstBinanceApiConfig } from '../order/apiConfigReader';
import { sendDingtalkMarkdown } from '../notification/dingtalk';

/**
 * 启动调度器
 */
export function startScheduler(): void {
  console.log('═══════════════════════════════════════');
  console.log('🚀 持仓分析服务启动');
  console.log(`📊 监控: ${config.watchlist.map(w => w.symbol).join(', ')}`);
  console.log(`⏰ 间隔: ${config.schedule.interval}`);
  console.log('═══════════════════════════════════════');

  // 启动定时任务
  cron.schedule(config.schedule.interval, async () => {
    console.log(`\n[${new Date().toISOString()}] 开始持仓分析...`);
    await runPositionAnalysis();
  });

  // 立即执行一次
  console.log('\n[启动] 执行首次持仓分析...');
  runPositionAnalysis();
}

/**
 * 持仓分析
 */
async function runPositionAnalysis(): Promise<void> {
  for (const item of config.watchlist) {
    await analyzeSymbolPosition(item.symbol);
    await sleep(2000);
  }
}

/**
 * 分析单个交易对的持仓
 */
async function analyzeSymbolPosition(symbol: string): Promise<void> {
  const key = `${symbol}@POS`;
  console.log(`\n[${key}] 开始持仓分析...`);

  try {
    // 获取持仓
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

    const positionsResult = await getPositions('binance', exchangeConfig, symbol);
    if (!positionsResult.success || !positionsResult.positions) {
      console.log(`[${key}] 获取持仓失败: ${positionsResult.error}`);
      return;
    }

    const positions = positionsResult.positions.filter(p => Math.abs(p.positionAmt) >= 0.001);
    if (positions.length === 0) {
      console.log(`[${key}] 无持仓`);
      return;
    }

    console.log(`[${key}] 发现持仓: ${positions.map(p => `${p.positionSide} ${p.positionAmt}`).join(', ')}`);

    // 获取当前价格
    const { getCurrentPrice } = await import('../order/binanceOrderApi');
    const currentPrice = await getCurrentPrice(result.config, symbol);
    if (!currentPrice) {
      console.log(`[${key}] 获取价格失败`);
      return;
    }
    console.log(`[${key}] 当前价格: $${currentPrice}`);

    // 获取 HTF 分析
    const baseCoin = symbol.replace('USDC', '').replace('USDT', '');
    const liquidation = await fetchLiquidation(baseCoin, '1d');
    const mtfResult = await analyzeMultiTimeframe(symbol, liquidation);

    // 构建分析 prompt
    const prompt = buildPositionAnalysisPrompt(
      positions,
      currentPrice,
      symbol,
      mtfResult.htf.bias,
      mtfResult.alignment,
      mtfResult.ltf.entry?.type || null
    );

    console.log(`[${key}] 分析 Prompt:\n${prompt}`);

    // 用规则简单分析
    const analysis = analyzePositionsByRules(
      positions,
      currentPrice,
      symbol,
      mtfResult.htf.bias,
      mtfResult.alignment,
      mtfResult.ltf.entry?.type || null
    );

    console.log(`[${key}] 分析结果: ${analysis.recommendation?.action} - ${analysis.recommendation?.reason}`);

    // 发送持仓分析消息
    const message = formatPositionAnalysis(analysis);
    await sendDingtalkMarkdown(`${symbol} 持仓分析`, message);

  } catch (error) {
    console.error(`[${key}] 持仓分析失败:`, error);
  }
}

/**
 * 格式化持仓分析消息
 */
function formatPositionAnalysis(analysis: PositionAnalysis): string {
  if (!analysis.hasPosition) {
    return `## ${analysis.symbol} 持仓\n\n无持仓`;
  }

  const pos = analysis.positions[0];
  const pnlEmoji = pos.pnl >= 0 ? '✅' : '❌';

  return `## ${analysis.symbol} 持仓

${pnlEmoji} ${pos.side === 'long' ? '多' : '空'} ${pos.amount}张
入场: $${pos.entryPrice.toFixed(2)}
当前: $${pos.currentPrice.toFixed(2)}
PnL: ${pos.pnl >= 0 ? '+' : ''}$${pos.pnl.toFixed(2)} (${pos.pnlPercent.toFixed(2)}%)
杠杆: ${pos.leverage}x

---
建议: ${analysis.recommendation?.action}
原因: ${analysis.recommendation?.reason}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
