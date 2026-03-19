/**
 * 任务调度器
 * 定时分析守塔策略挂单
 */

import cron from 'node-cron';
import { config } from '../config';
import { fetchLiquidation } from '../data/liquidationClient';
import { analyzeMultiTimeframe } from '../analysis/mtfAnalyzer';
import { buildOrderAnalysisPrompt, analyzeOrdersByRules, OrderAnalysis } from '../analysis/orderAnalyzer';
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
  const key = `${symbol}@ORDERS`;
  console.log(`\n[${key}] 开始订单分析...`);

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

    // 过滤守塔的订单（ict_tower 前缀）
    const towerOrders = ordersResult.orders.filter(o =>
      o.clientOrderId && o.clientOrderId.startsWith('ict_tower')
    );

    if (towerOrders.length === 0) {
      console.log(`[${key}] 无守塔订单`);
      return;
    }

    console.log(`[${key}] 发现守塔订单: ${towerOrders.length}个`);

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
    const prompt = buildOrderAnalysisPrompt(
      towerOrders,
      currentPrice,
      symbol,
      mtfResult.htf.bias,
      mtfResult.alignment,
      mtfResult.ltf.entry?.type || null
    );

    console.log(`[${key}] 分析 Prompt:\n${prompt}`);

    // 用规则简单分析
    const analysis = analyzeOrdersByRules(
      towerOrders,
      currentPrice,
      symbol,
      mtfResult.htf.bias,
      mtfResult.alignment,
      mtfResult.ltf.entry?.type || null
    );

    console.log(`[${key}] 分析结果: ${analysis.recommendation?.action} - ${analysis.recommendation?.reason}`);

    // 发送钉钉消息
    const message = formatOrderAnalysis(analysis);
    await sendDingtalkMarkdown(`${symbol} 订单分析`, message);

  } catch (error) {
    console.error(`[${key}] 订单分析失败:`, error);
  }
}

/**
 * 格式化订单分析消息
 */
function formatOrderAnalysis(analysis: OrderAnalysis): string {
  if (!analysis.hasOrders) {
    return `## ${analysis.symbol} 订单分析\n\n无守塔订单`;
  }

  const mkt = analysis.marketAnalysis;
  const orders = analysis.orders;

  // 按价格排序
  const sorted = [...orders].sort((a, b) => a.price - b.price);

  const orderList = sorted.map(o => {
    const side = o.side === 'buy' ? '多' : '空';
    const pos = o.positionSide === 'long' ? '多' : o.positionSide === 'short' ? '空' : '双';
    const dist = o.price > mkt.currentPrice
      ? `+${((o.price - mkt.currentPrice) / mkt.currentPrice * 100).toFixed(2)}%`
      : `${((o.price - mkt.currentPrice) / mkt.currentPrice * 100).toFixed(2)}%`;
    return `${side}${pos}: $${o.price.toFixed(2)} (${dist})`;
  }).join('\n');

  return `## ${analysis.symbol} 订单

价格: $${mkt.currentPrice.toFixed(2)} | HTF: ${mkt.htfDirection} | 对齐: ${mkt.alignment}%

${orderList}

---
${analysis.recommendation?.action}: ${analysis.recommendation?.reason}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
