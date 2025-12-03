/**
 * 消息格式化模块
 * 将交易信号转换为 Markdown 格式
 */

import { TradeSignal } from '../analysis/aiAnalyzer';
import { ICTAnalysisResult } from '../analysis/ictAnalyzer';

/**
 * 格式化交易信号为钉钉 Markdown 消息
 */
export function formatSignalMessage(
  signal: TradeSignal,
  ict: ICTAnalysisResult
): string {
  // 方向 emoji
  const directionEmoji =
    signal.direction === 'long'
      ? '🟢 做多'
      : signal.direction === 'short'
        ? '🔴 做空'
        : '⚪ 观望';

  // 置信度 emoji
  const confidenceEmoji = {
    high: '🔥 高',
    medium: '⚡ 中',
    low: '💤 低',
  }[signal.confidence];

  // 趋势 emoji
  const trendEmoji =
    ict.trend === 'bullish' ? '📈' : ict.trend === 'bearish' ? '📉' : '➡️';

  // 如果是观望
  if (signal.direction === 'neutral') {
    return `## ⚪ ${ict.symbol} ${ict.timeframe} 分析报告

**当前价格**: $${ict.currentPrice.toFixed(2)}
**趋势**: ${trendEmoji} ${ict.trend}
**建议**: 观望

---
### 分析
${signal.reasoning}

${
  signal.warnings.length > 0
    ? `### ⚠️ 注意
${signal.warnings.map(w => `- ${w}`).join('\n')}`
    : ''
}

---
*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
  }

  // 计算止损百分比
  const slPercent = (
    ((signal.stopLoss.price - signal.entry.price) / signal.entry.price) *
    100
  ).toFixed(2);

  // 构建止盈列表
  const tpList = signal.takeProfit
    .map((tp, i) => {
      const tpPercent = (
        ((tp.price - signal.entry.price) / signal.entry.price) *
        100
      ).toFixed(2);
      return `- **TP${i + 1}**: $${tp.price.toFixed(2)} (${tpPercent > '0' ? '+' : ''}${tpPercent}%) - ${tp.reason}`;
    })
    .join('\n');

  return `## ${directionEmoji} ${ict.symbol} ${ict.timeframe} 交易信号

**置信度**: ${confidenceEmoji}
**当前价格**: $${ict.currentPrice.toFixed(2)}
**趋势**: ${trendEmoji} ${ict.trend}

---
### 交易计划

**入场**: $${signal.entry.price.toFixed(2)}
> ${signal.entry.zone}

**止损**: $${signal.stopLoss.price.toFixed(2)} (${slPercent}%)
> ${signal.stopLoss.reason}

**止盈**:
${tpList || '- 未设置'}

**风险回报比**: 1:${signal.riskReward.toFixed(1)}

---
### 分析依据
${signal.reasoning}

${
  signal.warnings.length > 0
    ? `### ⚠️ 风险警示
${signal.warnings.map(w => `- ${w}`).join('\n')}`
    : ''
}

---
*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}

/**
 * 格式化服务启动消息
 */
export function formatStartupMessage(): string {
  return `## 🚀 分析服务已启动

**监控交易对**: BTCUSDC
**时间周期**: 15m, 1h, 4h
**执行间隔**: 每 15 分钟

*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}

/**
 * 格式化错误消息
 */
export function formatErrorMessage(error: string, context: string): string {
  return `## ❌ 分析服务错误

**上下文**: ${context}
**错误**: ${error}

*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}
