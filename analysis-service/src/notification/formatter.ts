/**
 * 消息格式化模块
 * 将交易信号转换为 Markdown 格式
 */

import { TradeSignal } from '../analysis/aiAnalyzer';
import { ICTAnalysisResult } from '../analysis/ictAnalyzer';
import { MTFAnalysis } from '../analysis/mtfAnalyzer';

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
  // 动态导入配置（避免循环依赖）
  const { config } = require('../config');
  const mode = config.analysis.mode;
  const symbols = config.watchlist.map((w: { symbol: string }) => w.symbol).join(', ');

  if (mode === 'mtf') {
    return `## 🚀 分析服务已启动

**监控交易对**: ${symbols}
**分析模式**: 多时间框架综合分析 (MTF)
**时间框架**:
- HTF: ${config.analysis.mtf.htf.join(', ')} (确定方向)
- MTF: ${config.analysis.mtf.mtf.join(', ')} (确认结构)
- LTF: ${config.analysis.mtf.ltf.join(', ')} (寻找入场)
**执行间隔**: ${config.schedule.interval}
**AI**: ${config.ai.provider}

*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
  }

  return `## 🚀 分析服务已启动

**监控交易对**: ${symbols}
**分析模式**: 独立周期分析
**时间周期**: ${config.analysis.singleTimeframes.join(', ')}
**执行间隔**: ${config.schedule.interval}
**AI**: ${config.ai.provider}

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

/**
 * 格式化 MTF 综合信号为钉钉 Markdown 消息
 */
export function formatMTFSignalMessage(
  signal: TradeSignal,
  mtf: MTFAnalysis
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

  // 偏向 emoji
  const biasEmoji = (bias: string) =>
    bias === 'bullish' ? '📈' : bias === 'bearish' ? '📉' : '➡️';

  // 如果是观望
  if (signal.direction === 'neutral') {
    return `## ⚪ ${mtf.symbol} MTF 综合分析报告

**当前价格**: $${mtf.currentPrice.toFixed(2)}
**对齐度**: ${mtf.alignment}%
**综合偏向**: ${biasEmoji(mtf.overallBias)} ${mtf.overallBias}
**建议**: 观望

---
### 时间框架分析
| 周期 | 趋势 | 结构 |
|------|------|------|
| 1D | ${biasEmoji(mtf.htf.daily.trend)} ${mtf.htf.daily.trend} | ${mtf.htf.daily.structure} |
| 4H | ${biasEmoji(mtf.htf.h4.trend)} ${mtf.htf.h4.trend} | ${mtf.htf.h4.structure} |
| 1H | ${biasEmoji(mtf.mtf.h1.trend)} ${mtf.mtf.h1.trend} | ${mtf.mtf.h1.structure} |
| 15M | ${biasEmoji(mtf.ltf.m15.trend)} ${mtf.ltf.m15.trend} | ${mtf.ltf.m15.structure} |
| 5M | ${biasEmoji(mtf.ltf.m5.trend)} ${mtf.ltf.m5.trend} | ${mtf.ltf.m5.structure} |

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

  // 入场设置信息
  let entrySetupInfo = '';
  if (mtf.ltf.entry) {
    entrySetupInfo = `
**入场类型**: ${mtf.ltf.entry.type.toUpperCase()}
**入场区间**: $${mtf.ltf.entry.entryZone.low.toFixed(2)} - $${mtf.ltf.entry.entryZone.high.toFixed(2)}`;
  }

  return `## ${directionEmoji} ${mtf.symbol} MTF 综合交易信号

**置信度**: ${confidenceEmoji}
**当前价格**: $${mtf.currentPrice.toFixed(2)}
**对齐度**: ${mtf.alignment}%

---
### 多时间框架分析
| 周期 | 趋势 | 结构 | 状态 |
|------|------|------|------|
| 1D | ${biasEmoji(mtf.htf.daily.trend)} ${mtf.htf.daily.trend} | ${mtf.htf.daily.structure} | ${mtf.htf.daily.trend === mtf.overallBias ? '✅' : '⚠️'} |
| 4H | ${biasEmoji(mtf.htf.h4.trend)} ${mtf.htf.h4.trend} | ${mtf.htf.h4.structure} | ${mtf.htf.aligned ? '✅' : '⚠️'} |
| 1H | ${biasEmoji(mtf.mtf.h1.trend)} ${mtf.mtf.h1.trend} | ${mtf.mtf.h1.structure} | ${mtf.mtf.confirmed ? '✅' : '⚠️'} |
| 15M | ${biasEmoji(mtf.ltf.m15.trend)} ${mtf.ltf.m15.trend} | ${mtf.ltf.m15.structure} | - |
| 5M | ${biasEmoji(mtf.ltf.m5.trend)} ${mtf.ltf.m5.trend} | ${mtf.ltf.m5.structure} | - |

**HTF 偏向**: ${biasEmoji(mtf.htf.bias)} ${mtf.htf.bias} (日线+4H ${mtf.htf.aligned ? '对齐' : '未对齐'})
**MTF 确认**: ${mtf.mtf.confirmed ? '✅ 已确认' : '❌ 未确认'}

---
### 交易计划
${entrySetupInfo}
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
