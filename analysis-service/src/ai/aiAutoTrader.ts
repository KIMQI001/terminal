/**
 * AI 自动交易器
 * 当有新信号时，检查托管配置并自动下单
 */

import { TradeSignal } from '../analysis/aiAnalyzer';
import { getActiveAIManagements, AIManagementConfig } from './aiManagementStore';
import { getBinanceApiConfig } from '../order/apiConfigReader';
import { placeOrder } from '../order/binanceOrderApi';
import { addPendingOrder } from '../order/pendingOrderStore';
import { sendDingtalkMarkdownToUser } from '../notification/dingtalk';

/**
 * 处理新信号 - 检查托管配置并下单
 * 在 scheduler 保存信号后调用
 */
export async function handleNewSignalForAutoTrade(
  signal: TradeSignal,
  symbol: string,
  timeframe: string
): Promise<void> {
  // 获取该交易对所有激活的托管配置
  const activeConfigs = getActiveAIManagements(symbol);

  if (activeConfigs.length === 0) {
    return; // 没有用户开启托管
  }

  console.log(`[AIAutoTrader] 新信号: ${symbol}@${timeframe} ${signal.direction}, 托管用户数: ${activeConfigs.length}`);

  // 为每个开启托管的用户下单
  for (const config of activeConfigs) {
    try {
      await placeOrderForUser(config, signal, timeframe);
    } catch (error) {
      console.error(`[AIAutoTrader] 用户 ${config.userId} 下单失败:`, error);
    }
  }
}

/**
 * 为单个用户下单
 */
async function placeOrderForUser(
  config: AIManagementConfig,
  signal: TradeSignal,
  timeframe: string
): Promise<void> {
  // 获取用户 API 配置
  const apiConfig = getBinanceApiConfig(config.userId);
  if (!apiConfig) {
    console.error(`[AIAutoTrader] 用户 ${config.userId} 无 API 配置`);
    return;
  }

  const entryPrice = signal.entry.price;
  const stopLoss = signal.stopLoss.price;
  const takeProfit = signal.takeProfit?.[0]?.price || (
    signal.direction === 'long'
      ? entryPrice * 1.02
      : entryPrice * 0.98
  );

  // 计算数量（20 倍杠杆）
  const leverage = 20;
  const positionValue = config.baseMargin * leverage;
  const quantity = Math.floor((positionValue / entryPrice) * 1000) / 1000;

  const side = signal.direction === 'long' ? 'BUY' : 'SELL';
  const positionSide = signal.direction === 'long' ? 'LONG' : 'SHORT';

  // 生成 clientOrderId
  const ts = Math.floor(Date.now() / 1000);
  const clientOrderId = `aia_${timeframe}_${side[0].toLowerCase()}_${ts}`;

  console.log(`[AIAutoTrader] 用户 ${config.userId} 下单: ${side} ${quantity} @ ${entryPrice}`);

  try {
    // 下限价入场单
    const orderResult = await placeOrder(
      apiConfig,
      {
        symbol: config.symbol,
        side: side as 'BUY' | 'SELL',
        positionSide: positionSide as 'LONG' | 'SHORT',
        type: 'LIMIT',
        quantity,
        price: entryPrice,
        clientOrderId,
      }
    );

    if (!orderResult.success) {
      throw new Error(orderResult.error || '下单失败');
    }

    console.log(`[AIAutoTrader] 入场单成功: ${clientOrderId}`);

    // 保存到待处理订单
    addPendingOrder({
      clientOrderId,
      symbol: config.symbol,
      side: side as 'BUY' | 'SELL',
      positionSide: positionSide as 'LONG' | 'SHORT',
      entryPrice,
      quantity,
      stopLoss,
      takeProfit,
    });

    // 发送钉钉通知
    await sendDingtalkMarkdownToUser(
      config.userId,
      `AI 托管下单 ${signal.direction === 'long' ? '做多' : '做空'}`,
      [
        `### AI 托管自动下单 ${signal.direction === 'long' ? '🟢' : '🔴'}`,
        '',
        `- **交易对**: ${config.symbol}`,
        `- **周期**: ${timeframe}`,
        `- **方向**: ${signal.direction === 'long' ? '做多' : '做空'}`,
        `- **置信度**: ${signal.confidence}`,
        `- **入场价**: $${entryPrice.toFixed(2)}`,
        `- **止损**: $${stopLoss.toFixed(2)}`,
        `- **止盈**: $${takeProfit.toFixed(2)}`,
        `- **数量**: ${quantity}`,
        `- **保证金**: ${config.baseMargin} U`,
      ].join('\n')
    );

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[AIAutoTrader] 下单失败:`, error);

    // 发送错误通知
    await sendDingtalkMarkdownToUser(
      config.userId,
      'AI 托管下单失败',
      [
        `### AI 托管下单失败 ❌`,
        '',
        `- **交易对**: ${config.symbol}`,
        `- **周期**: ${timeframe}`,
        `- **错误**: ${errorMsg}`,
      ].join('\n')
    );
  }
}
