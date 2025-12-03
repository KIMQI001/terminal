/**
 * 消息格式化模块
 * 将交易信号转换为 Markdown 格式（修仙风格）
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
  // 方向
  const directionEmoji =
    signal.direction === 'long'
      ? '🐉 龙升'
      : signal.direction === 'short'
        ? '🐍 蛇降'
        : '🧘 静修';

  // 置信度
  const confidenceEmoji = {
    high: '🔥 天命',
    medium: '⚡ 良机',
    low: '💨 虚无',
  }[signal.confidence];

  // 趋势
  const trendEmoji =
    ict.trend === 'bullish' ? '☯️ 阳盛' : ict.trend === 'bearish' ? '☯️ 阴盛' : '☯️ 阴阳平衡';

  // 如果是观望
  if (signal.direction === 'neutral') {
    return `## 🧘 ${ict.symbol} ${ict.timeframe} 天机卷

**灵石现价**: $${ict.currentPrice.toFixed(2)}
**气运**: ${trendEmoji}
**天意**: 静待时机

---
### 推演
${signal.reasoning}

${
  signal.warnings.length > 0
    ? `### ⚠️ 劫难预警
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
      return `- **${i + 1}重天**: $${tp.price.toFixed(2)} (${tpPercent > '0' ? '+' : ''}${tpPercent}%) - ${tp.reason}`;
    })
    .join('\n');

  return `## ${directionEmoji} ${ict.symbol} ${ict.timeframe} 天机令

**道心**: ${confidenceEmoji}
**灵石现价**: $${ict.currentPrice.toFixed(2)}
**气运**: ${trendEmoji}

---
### 修炼心法

**入道**: $${signal.entry.price.toFixed(2)}
> ${signal.entry.zone}

**渡劫线**: $${signal.stopLoss.price.toFixed(2)} (${slPercent}%)
> ${signal.stopLoss.reason}

**飞升境界**:
${tpList || '- 随缘'}

**因果比**: 1:${signal.riskReward.toFixed(1)}

---
### 天道感悟
${signal.reasoning}

${
  signal.warnings.length > 0
    ? `### ⚠️ 劫难预警
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
    return `## ⚔️ 天道轮盘已开启

**观测灵石**: ${symbols}

**修炼法门**: 三界同观 (MTF)

**时空法则**:
- 天界: ${config.analysis.mtf.htf.join(', ')} (定乾坤)
- 人界: ${config.analysis.mtf.mtf.join(', ')} (察因果)
- 地界: ${config.analysis.mtf.ltf.join(', ')} (寻机缘)

**轮回周期**: ${config.schedule.interval}

**道法**: ${config.ai.provider}

*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
  }

  return `## ⚔️ 天道轮盘已开启

**观测灵石**: ${symbols}

**修炼法门**: 单境推演

**时空法则**: ${config.analysis.singleTimeframes.join(', ')}

**轮回周期**: ${config.schedule.interval}

**道法**: ${config.ai.provider}

*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}

/**
 * 格式化错误消息
 */
export function formatErrorMessage(error: string, context: string): string {
  return `## ❌ 天道紊乱

**劫难所在**: ${context}
**异象**: ${error}

*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}

/**
 * 格式化 MTF 综合信号为钉钉 Markdown 消息
 */
export function formatMTFSignalMessage(
  signal: TradeSignal,
  mtf: MTFAnalysis
): string {
  // 方向
  const directionEmoji =
    signal.direction === 'long'
      ? '🐉 龙升'
      : signal.direction === 'short'
        ? '🐍 蛇降'
        : '🧘 静修';

  // 置信度
  const confidenceEmoji = {
    high: '🔥 天命',
    medium: '⚡ 良机',
    low: '💨 虚无',
  }[signal.confidence];

  // 气运
  const biasEmoji = (bias: string) =>
    bias === 'bullish' ? '☯️ 阳' : bias === 'bearish' ? '☯️ 阴' : '☯️ 混沌';

  // 如果是观望
  if (signal.direction === 'neutral') {
    return `## 🧘 ${mtf.symbol} 三界天机卷

**灵石现价**: $${mtf.currentPrice.toFixed(2)}
**天道契合**: ${mtf.alignment}%
**总气运**: ${biasEmoji(mtf.overallBias)} ${mtf.overallBias}
**天意**: 闭关静修

---
### 三界气运
| 境界 | 气运 | 结构 |
|------|------|------|
| 天界·日 | ${biasEmoji(mtf.htf.daily.trend)} ${mtf.htf.daily.trend} | ${mtf.htf.daily.structure} |
| 天界·时 | ${biasEmoji(mtf.htf.h4.trend)} ${mtf.htf.h4.trend} | ${mtf.htf.h4.structure} |
| 人界 | ${biasEmoji(mtf.mtf.h1.trend)} ${mtf.mtf.h1.trend} | ${mtf.mtf.h1.structure} |
| 地界·刻 | ${biasEmoji(mtf.ltf.m15.trend)} ${mtf.ltf.m15.trend} | ${mtf.ltf.m15.structure} |
| 地界·息 | ${biasEmoji(mtf.ltf.m5.trend)} ${mtf.ltf.m5.trend} | ${mtf.ltf.m5.structure} |

---
### 天机
${signal.reasoning}

${
  signal.warnings.length > 0
    ? `### ⚠️ 劫难预警
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
      return `- **${i + 1}重天**: $${tp.price.toFixed(2)} (${tpPercent > '0' ? '+' : ''}${tpPercent}%) - ${tp.reason}`;
    })
    .join('\n');

  // 入场设置信息
  let entrySetupInfo = '';
  if (mtf.ltf.entry) {
    entrySetupInfo = `
**入道法门**: ${mtf.ltf.entry.type.toUpperCase()}
**机缘区间**: $${mtf.ltf.entry.entryZone.low.toFixed(2)} - $${mtf.ltf.entry.entryZone.high.toFixed(2)}`;
  }

  return `## ${directionEmoji} ${mtf.symbol} 三界天机令

**道心**: ${confidenceEmoji}
**灵石现价**: $${mtf.currentPrice.toFixed(2)}
**天道契合**: ${mtf.alignment}%

---
### 三界气运
| 境界 | 气运 | 结构 | 天道 |
|------|------|------|------|
| 天界·日 | ${biasEmoji(mtf.htf.daily.trend)} ${mtf.htf.daily.trend} | ${mtf.htf.daily.structure} | ${mtf.htf.daily.trend === mtf.overallBias ? '✅' : '⚠️'} |
| 天界·时 | ${biasEmoji(mtf.htf.h4.trend)} ${mtf.htf.h4.trend} | ${mtf.htf.h4.structure} | ${mtf.htf.aligned ? '✅' : '⚠️'} |
| 人界 | ${biasEmoji(mtf.mtf.h1.trend)} ${mtf.mtf.h1.trend} | ${mtf.mtf.h1.structure} | ${mtf.mtf.confirmed ? '✅' : '⚠️'} |
| 地界·刻 | ${biasEmoji(mtf.ltf.m15.trend)} ${mtf.ltf.m15.trend} | ${mtf.ltf.m15.structure} | - |
| 地界·息 | ${biasEmoji(mtf.ltf.m5.trend)} ${mtf.ltf.m5.trend} | ${mtf.ltf.m5.structure} | - |

**天界气运**: ${biasEmoji(mtf.htf.bias)} ${mtf.htf.bias} (${mtf.htf.aligned ? '阴阳合' : '阴阳离'})
**人界印证**: ${mtf.mtf.confirmed ? '✅ 天人合一' : '❌ 天人相悖'}

---
### 修炼心法
${entrySetupInfo}
**入道**: $${signal.entry.price.toFixed(2)}
> ${signal.entry.zone}

**渡劫线**: $${signal.stopLoss.price.toFixed(2)} (${slPercent}%)
> ${signal.stopLoss.reason}

**飞升境界**:
${tpList || '- 随缘'}

**因果比**: 1:${signal.riskReward.toFixed(1)}

---
### 天道感悟
${signal.reasoning}

${
  signal.warnings.length > 0
    ? `### ⚠️ 劫难预警
${signal.warnings.map(w => `- ${w}`).join('\n')}`
    : ''
}

---
*${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;
}
