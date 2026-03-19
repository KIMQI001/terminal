/**
 * 消息格式化模块
 * 将交易信号转换为简洁的 Markdown 格式
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
  const directionLabel = {
    long: '做多',
    short: '做空',
    neutral: '观望',
  }[signal.direction];

  const confidenceLabel = {
    high: '高',
    medium: '中',
    low: '低',
  }[signal.confidence];

  const trendLabel = {
    bullish: '看涨',
    bearish: '看跌',
    neutral: '中性',
  }[ict.trend];

  if (signal.direction === 'neutral') {
    return `## ${ict.symbol} ${ict.timeframe} 信号

**现价**: $${ict.currentPrice.toFixed(2)}
**趋势**: ${trendLabel}
**结论**: ${signal.reasoning}

${signal.warnings.length > 0 ? `**警告**:\n${signal.warnings.map(w => `- ${w}`).join('\n')}` : ''}

---
*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
  }

  const slPercent = (
    ((signal.stopLoss.price - signal.entry.price) / signal.entry.price) *
    100
  ).toFixed(2);

  const tpList = signal.takeProfit
    .map((tp, i) => {
      const tpPercent = (
        ((tp.price - signal.entry.price) / signal.entry.price) *
        100
      ).toFixed(2);
      return `- TP${i + 1}: $${tp.price.toFixed(2)} (${tpPercent > '0' ? '+' : ''}${tpPercent}%) - ${tp.reason}`;
    })
    .join('\n');

  return `## ${directionLabel} ${ict.symbol} ${ict.timeframe}

**置信度**: ${confidenceLabel}
**现价**: $${ict.currentPrice.toFixed(2)}
**趋势**: ${trendLabel}

---
**入场**: $${signal.entry.price.toFixed(2)}
> ${signal.entry.zone}

**止损**: $${signal.stopLoss.price.toFixed(2)} (${slPercent}%)
> ${signal.stopLoss.reason}

**止盈**:
${tpList || '- 无'}

**RR**: 1:${signal.riskReward.toFixed(1)}

---
**分析**: ${signal.reasoning}

${signal.warnings.length > 0 ? `**警告**:\n${signal.warnings.map(w => `- ${w}`).join('\n')}` : ''}

---
*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}

/**
 * 格式化服务启动消息
 */
export function formatStartupMessage(): string {
  const { config } = require('../config');
  const mode = config.analysis.mode;
  const symbols = config.watchlist.map((w: { symbol: string }) => w.symbol).join(', ');

  if (mode === 'mtf') {
    return `## 分析服务已启动

**交易对**: ${symbols}

**模式**: MTF 多时间框架

**时间框架**:
- HTF: ${config.analysis.mtf.htf.join(', ')}
- MTF: ${config.analysis.mtf.mtf.join(', ')}
- LTF: ${config.analysis.mtf.ltf.join(', ')}

**调度**: ${config.schedule.interval}

**AI**: ${config.ai.provider}

*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
  }

  return `## 分析服务已启动

**交易对**: ${symbols}

**模式**: 单周期

**时间框架**: ${config.analysis.singleTimeframes.join(', ')}

**调度**: ${config.schedule.interval}

**AI**: ${config.ai.provider}

*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}

/**
 * 格式化错误消息
 */
export function formatErrorMessage(error: string, context: string): string {
  return `## 错误

**位置**: ${context}
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
  const directionLabel = {
    long: '做多',
    short: '做空',
    neutral: '观望',
  }[signal.direction];

  const confidenceLabel = {
    high: '高',
    medium: '中',
    low: '低',
  }[signal.confidence];

  const biasLabel = (bias: string) =>
    bias === 'bullish' ? '多' : bias === 'bearish' ? '空' : '中';

  if (signal.direction === 'neutral') {
    return `## ${mtf.symbol} MTF 信号

**现价**: $${mtf.currentPrice.toFixed(2)}
**对齐度**: ${mtf.alignment}%
**趋势**: ${biasLabel(mtf.overallBias)}

---
### 各周期趋势
| 周期 | 趋势 | 结构 |
|------|------|------|
| 4D | ${biasLabel(mtf.htf.fourDay.trend)} | ${mtf.htf.fourDay.structure} |
| 1D | ${biasLabel(mtf.htf.daily.trend)} | ${mtf.htf.daily.structure} |
| 4H | ${biasLabel(mtf.htf.h4.trend)} | ${mtf.htf.h4.structure} |
| 1H | ${biasLabel(mtf.mtf.h1.trend)} | ${mtf.mtf.h1.structure} |
| 15M | ${biasLabel(mtf.ltf.m15.trend)} | ${mtf.ltf.m15.structure} |
| 5M | ${biasLabel(mtf.ltf.m5.trend)} | ${mtf.ltf.m5.structure} |

---
**结论**: ${signal.reasoning}

${signal.warnings.length > 0 ? `**警告**:\n${signal.warnings.map(w => `- ${w}`).join('\n')}` : ''}

---
*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
  }

  const slPercent = (
    ((signal.stopLoss.price - signal.entry.price) / signal.entry.price) *
    100
  ).toFixed(2);

  const tpList = signal.takeProfit
    .map((tp, i) => {
      const tpPercent = (
        ((tp.price - signal.entry.price) / signal.entry.price) *
        100
      ).toFixed(2);
      return `- TP${i + 1}: $${tp.price.toFixed(2)} (${tpPercent > '0' ? '+' : ''}${tpPercent}%) - ${tp.reason}`;
    })
    .join('\n');

  let entryInfo = '';
  if (mtf.ltf.entry) {
    entryInfo = `**入场类型**: ${mtf.ltf.entry.type.toUpperCase()}\n**入场区间**: $${mtf.ltf.entry.entryZone.low.toFixed(2)} - $${mtf.ltf.entry.entryZone.high.toFixed(2)}\n`;
  }

  return `## ${directionLabel} ${mtf.symbol}

**置信度**: ${confidenceLabel}
**现价**: $${mtf.currentPrice.toFixed(2)}
**对齐度**: ${mtf.alignment}%

---
### 各周期趋势
| 周期 | 趋势 | 结构 | 确认 |
|------|------|------|------|
| 4D | ${biasLabel(mtf.htf.fourDay.trend)} | ${mtf.htf.fourDay.structure} | - |
| 1D | ${biasLabel(mtf.htf.daily.trend)} | ${mtf.htf.daily.structure} | ${mtf.htf.daily.trend === mtf.overallBias ? '✅' : '⚠️'} |
| 4H | ${biasLabel(mtf.htf.h4.trend)} | ${mtf.htf.h4.structure} | ${mtf.htf.aligned ? '✅' : '⚠️'} |
| 1H | ${biasLabel(mtf.mtf.h1.trend)} | ${mtf.mtf.h1.structure} | ${mtf.mtf.confirmed ? '✅' : '⚠️'} |
| 15M | ${biasLabel(mtf.ltf.m15.trend)} | ${mtf.ltf.m15.structure} | - |
| 5M | ${biasLabel(mtf.ltf.m5.trend)} | ${mtf.ltf.m5.structure} | - |

---
### 交易设置
${entryInfo}**入场**: $${signal.entry.price.toFixed(2)}
> ${signal.entry.zone}

**止损**: $${signal.stopLoss.price.toFixed(2)} (${slPercent}%)
> ${signal.stopLoss.reason}

**止盈**:
${tpList || '- 无'}

**RR**: 1:${signal.riskReward.toFixed(1)}

---
**分析**: ${signal.reasoning}

${signal.warnings.length > 0 ? `**警告**:\n${signal.warnings.map(w => `- ${w}`).join('\n')}` : ''}

---
*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}

/**
 * 格式化反转信号为钉钉 Markdown 消息
 */
export function formatReversalSignalMessage(
  signal: TradeSignal,
  mtf: MTFAnalysis
): string {
  const directionLabel = {
    long: '逆势做多',
    short: '逆势做空',
    neutral: '观望',
  }[signal.direction];

  const confidenceLabel = {
    high: '高',
    medium: '中',
    low: '低',
  }[signal.confidence];

  const biasLabel = (bias: string) =>
    bias === 'bullish' ? '多' : bias === 'bearish' ? '空' : '中';

  if (signal.direction === 'neutral') {
    return `## ${mtf.symbol} 反转信号

**现价**: $${mtf.currentPrice.toFixed(2)}
**HTF趋势**: ${biasLabel(mtf.htf.bias)}
**LTF趋势**: ${biasLabel(mtf.reversal.ltfBias)} (${mtf.reversal.ltfAlignment}%)

---
**结论**: ${signal.reasoning}

${signal.warnings.length > 0 ? `**警告**:\n${signal.warnings.map(w => `- ${w}`).join('\n')}` : ''}

---
*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
  }

  const slPercent = (
    ((signal.stopLoss.price - signal.entry.price) / signal.entry.price) *
    100
  ).toFixed(2);

  const tpList = signal.takeProfit
    .map((tp, i) => {
      const tpPercent = (
        ((tp.price - signal.entry.price) / signal.entry.price) *
        100
      ).toFixed(2);
      return `- TP${i + 1}: $${tp.price.toFixed(2)} (${tpPercent > '0' ? '+' : ''}${tpPercent}%) - ${tp.reason}`;
    })
    .join('\n');

  let entryInfo = '';
  if (mtf.reversal.entry) {
    entryInfo = `**入场类型**: ${mtf.reversal.entry.type.toUpperCase()}\n**入场区间**: $${mtf.reversal.entry.entryZone.low.toFixed(2)} - $${mtf.reversal.entry.entryZone.high.toFixed(2)}\n`;
  }

  return `## ${directionLabel} ${mtf.symbol}

⚠️ **警告**: 逆势交易，风险较高

**置信度**: ${confidenceLabel}
**现价**: $${mtf.currentPrice.toFixed(2)}

---
### HTF vs LTF
| 周期 | 趋势 |
|------|------|
| HTF (日/4H) | ${biasLabel(mtf.htf.bias)} |
| LTF (1H/15m/5m) | ${biasLabel(mtf.reversal.ltfBias)} (${mtf.reversal.ltfAlignment}%) |

LTF 与 HTF 趋势相反，谨慎入场。

---
### 交易设置
${entryInfo}**入场**: $${signal.entry.price.toFixed(2)}
> ${signal.entry.zone}

**止损**: $${signal.stopLoss.price.toFixed(2)} (${slPercent}%)
> ${signal.stopLoss.reason}

**止盈**:
${tpList || '- 无'}

**RR**: 1:${signal.riskReward.toFixed(1)}

---
**分析**: ${signal.reasoning}

**风险提示**:
${signal.warnings.map(w => `- ${w}`).join('\n')}

---
*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}
