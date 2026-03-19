/**
 * 消息格式化模块
 */

import { TradeSignal } from '../analysis/aiAnalyzer';
import { ICTAnalysisResult } from '../analysis/ictAnalyzer';
import { MTFAnalysis } from '../analysis/mtfAnalyzer';

export function formatSignalMessage(
  signal: TradeSignal,
  ict: ICTAnalysisResult
): string {
  if (signal.direction === 'neutral') {
    return `## ${ict.symbol} ${ict.timeframe} 观望

现价: $${ict.currentPrice.toFixed(2)}
趋势: ${ict.trend}
${signal.reasoning}
${signal.warnings.length > 0 ? `\n${signal.warnings.join('\n')}` : ''}`;
  }

  const sl = ((signal.stopLoss.price - signal.entry.price) / signal.entry.price * 100).toFixed(2);
  const tp1 = signal.takeProfit[0];
  const tp1Pct = tp1 ? ((tp1.price - signal.entry.price) / signal.entry.price * 100).toFixed(1) : '-';

  return `## ${signal.direction === 'long' ? '多' : '空'} ${ict.symbol} ${ict.timeframe}

入场: $${signal.entry.price.toFixed(2)}
止损: $${signal.stopLoss.price.toFixed(2)} (${sl}%)
TP1: $${tp1?.price.toFixed(2)} (+${tp1Pct}%) ${tp1?.reason || ''}
RR: 1:${signal.riskReward.toFixed(1)}

${signal.reasoning.slice(0, 100)}${signal.reasoning.length > 100 ? '...' : ''}`;
}

export function formatStartupMessage(): string {
  const { config } = require('../config');
  const symbols = config.watchlist.map((w: { symbol: string }) => w.symbol).join(', ');
  return `## 分析服务已启动

交易对: ${symbols}
AI: ${config.ai.provider}
调度: ${config.schedule.interval}`;
}

export function formatErrorMessage(error: string, context: string): string {
  return `## 错误

位置: ${context}
错误: ${error}`;
}

export function formatMTFSignalMessage(
  signal: TradeSignal,
  mtf: MTFAnalysis
): string {
  const dir = { long: '多', short: '空', neutral: '观望' }[signal.direction];

  if (signal.direction === 'neutral') {
    return `## ${mtf.symbol} 观望

现价: $${mtf.currentPrice.toFixed(2)}
对齐: ${mtf.alignment}%
HTF: ${mtf.htf.bias}
${signal.reasoning.slice(0, 80)}`;
  }

  const sl = ((signal.stopLoss.price - signal.entry.price) / signal.entry.price * 100).toFixed(2);
  const tp1 = signal.takeProfit[0];
  const tp1Pct = tp1 ? ((tp1.price - signal.entry.price) / signal.entry.price * 100).toFixed(1) : '-';

  return `## ${dir} ${mtf.symbol}

现价: $${mtf.currentPrice.toFixed(2)} | 对齐: ${mtf.alignment}% | HTF: ${mtf.htf.bias}
入场: $${signal.entry.price.toFixed(2)} | 止损: $${signal.stopLoss.price.toFixed(2)} (${sl}%)
TP1: $${tp1?.price.toFixed(2)} (+${tp1Pct}%) | RR: 1:${signal.riskReward.toFixed(1)}

${signal.reasoning.slice(0, 100)}${signal.reasoning.length > 100 ? '...' : ''}`;
}

export function formatReversalSignalMessage(
  signal: TradeSignal,
  mtf: MTFAnalysis
): string {
  const dir = { long: '逆多', short: '逆空', neutral: '观望' }[signal.direction];

  if (signal.direction === 'neutral') {
    return `## ${mtf.symbol} 反转观望

现价: $${mtf.currentPrice.toFixed(2)}
HTF: ${mtf.htf.bias} | LTF: ${mtf.reversal.ltfBias} (${mtf.reversal.ltfAlignment}%)
${signal.reasoning.slice(0, 80)}`;
  }

  const sl = ((signal.stopLoss.price - signal.entry.price) / signal.entry.price * 100).toFixed(2);
  const tp1 = signal.takeProfit[0];
  const tp1Pct = tp1 ? ((tp1.price - signal.entry.price) / signal.entry.price * 100).toFixed(1) : '-';

  return `## ${dir} ${mtf.symbol} ⚠️逆势

现价: $${mtf.currentPrice.toFixed(2)}
HTF: ${mtf.htf.bias} | LTF: ${mtf.reversal.ltfBias}
入场: $${signal.entry.price.toFixed(2)} | 止损: $${signal.stopLoss.price.toFixed(2)} (${sl}%)
TP1: $${tp1?.price.toFixed(2)} (+${tp1Pct}%) | RR: 1:${signal.riskReward.toFixed(1)}

${signal.reasoning.slice(0, 100)}${signal.reasoning.length > 100 ? '...' : ''}`;
}
