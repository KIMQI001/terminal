/**
 * 多时间框架分析器 (MTF Analyzer)
 *
 * 实现 ICT 自上而下的分析方法:
 * 1. HTF (1d/4h) - 确定主趋势方向
 * 2. MTF (1h) - 确认结构 (BOS/CHoCH)
 * 3. LTF (15m/5m) - 寻找精确入场点
 */

import { fetchKlines, Candle, Timeframe } from '../data/klineClient';
import {
  analyzeICT,
  ICTAnalysisResult,
  SwingPoint,
  FVG,
  OTEZone,
  BOS,
  CHoCH,
} from './ictAnalyzer';

// ============================================
// 类型定义
// ============================================

export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface TimeframeAnalysis {
  timeframe: Timeframe;
  trend: Bias;
  structure: 'bos' | 'choch' | 'none';
  structureType?: Bias;
  swingPoints: SwingPoint[];
  latestBOS?: BOS;
  latestCHoCH?: CHoCH;
}

export interface EntrySetup {
  type: 'ote' | 'fvg';
  bias: Bias;
  entryZone: { high: number; low: number };
  suggestedEntry: number;
  stopLoss: number;
  takeProfits: number[];
  riskReward: number;
}

export interface MTFAnalysis {
  symbol: string;
  timestamp: number;
  currentPrice: number;

  // 各时间框架分析
  htf: {
    daily: TimeframeAnalysis;
    h4: TimeframeAnalysis;
    bias: Bias;
    aligned: boolean;
  };
  mtf: {
    h1: TimeframeAnalysis;
    confirmed: boolean;
  };
  ltf: {
    m15: TimeframeAnalysis;
    m5: TimeframeAnalysis;
    entry: EntrySetup | null;
  };

  // 原始 K 线数据（供 AI 分析形态）
  klines: {
    h1: Candle[];   // 最近 24 根
    m15: Candle[];  // 最近 16 根
    m5: Candle[];   // 最近 12 根
  };

  // 综合结果
  overallBias: Bias;
  alignment: number;  // 0-100 对齐度
  tradeable: boolean;
  summary: string;
}

// ============================================
// 时间框架分析函数
// ============================================

/**
 * 分析单个时间框架
 */
function analyzeTimeframe(ict: ICTAnalysisResult): TimeframeAnalysis {
  const latestBOS = ict.bos.length > 0 ? ict.bos[ict.bos.length - 1] : undefined;
  const latestCHoCH = ict.choch.length > 0 ? ict.choch[ict.choch.length - 1] : undefined;

  // 判断结构类型
  let structure: 'bos' | 'choch' | 'none' = 'none';
  let structureType: Bias | undefined;

  if (latestCHoCH) {
    structure = 'choch';
    structureType = latestCHoCH.type;
  } else if (latestBOS) {
    structure = 'bos';
    structureType = latestBOS.type;
  }

  return {
    timeframe: ict.timeframe,
    trend: ict.trend,
    structure,
    structureType,
    swingPoints: ict.swingPoints,
    latestBOS,
    latestCHoCH,
  };
}

/**
 * 分析 HTF (高时间框架)
 *
 * 规则:
 * - 1d 和 4h 趋势一致 → 明确偏向
 * - 1d 和 4h 趋势相反 → neutral (等待确认)
 * - CHoCH 权重高于 BOS
 */
function analyzeHTF(
  daily: TimeframeAnalysis,
  h4: TimeframeAnalysis
): { bias: Bias; aligned: boolean } {
  // 如果日线有 CHoCH，优先采用
  if (daily.structure === 'choch' && daily.structureType) {
    // 4H 需要确认或至少不反向
    if (h4.trend === daily.structureType || h4.trend === 'neutral') {
      return { bias: daily.structureType, aligned: true };
    }
    // 4H 反向，等待确认
    return { bias: 'neutral', aligned: false };
  }

  // 日线和 4H 趋势一致
  if (daily.trend === h4.trend && daily.trend !== 'neutral') {
    return { bias: daily.trend, aligned: true };
  }

  // 只有一个有明确趋势
  if (daily.trend !== 'neutral' && h4.trend === 'neutral') {
    return { bias: daily.trend, aligned: false };
  }
  if (h4.trend !== 'neutral' && daily.trend === 'neutral') {
    return { bias: h4.trend, aligned: false };
  }

  // 趋势相反或都是 neutral
  return { bias: 'neutral', aligned: false };
}

/**
 * 分析 MTF (中时间框架)
 *
 * 规则:
 * - 1H 结构需要确认 HTF 方向
 * - BOS 表示趋势延续
 * - CHoCH 表示趋势反转
 */
function analyzeMTF(
  h1: TimeframeAnalysis,
  htfBias: Bias
): { confirmed: boolean } {
  if (htfBias === 'neutral') {
    return { confirmed: false };
  }

  // CHoCH 与 HTF 方向一致 → 强确认
  if (h1.structure === 'choch' && h1.structureType === htfBias) {
    return { confirmed: true };
  }

  // BOS 与 HTF 方向一致 → 确认
  if (h1.structure === 'bos' && h1.structureType === htfBias) {
    return { confirmed: true };
  }

  // 趋势方向一致（无明确结构变化）
  if (h1.trend === htfBias) {
    return { confirmed: true };
  }

  return { confirmed: false };
}

/**
 * 在 LTF 寻找入场机会
 */
function findLTFEntry(
  m15: ICTAnalysisResult,
  m5: ICTAnalysisResult,
  htfBias: Bias,
  currentPrice: number
): EntrySetup | null {
  // 优先使用 15m 的 OTE 区域
  const activeOTE = m15.oteZones.find(
    ote => ote.active && ote.type === htfBias
  );

  if (activeOTE) {
    const isLong = htfBias === 'bullish';
    const entry = activeOTE.fib675;
    const stopLoss = isLong
      ? activeOTE.swingLow * 0.998  // 稍微留余地
      : activeOTE.swingHigh * 1.002;

    const risk = Math.abs(entry - stopLoss);
    const tp1 = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
    const tp2 = isLong ? entry + risk * 2.5 : entry - risk * 2.5;
    const tp3 = isLong ? entry + risk * 4 : entry - risk * 4;

    return {
      type: 'ote',
      bias: htfBias,
      entryZone: {
        high: isLong ? activeOTE.fib618 : activeOTE.fib786,
        low: isLong ? activeOTE.fib786 : activeOTE.fib618,
      },
      suggestedEntry: entry,
      stopLoss,
      takeProfits: [tp1, tp2, tp3],
      riskReward: 2.5,  // 默认目标 TP2
    };
  }

  // 使用 15m 或 5m 的未填充 FVG
  const fvgCandidates = [...m15.fvgs, ...m5.fvgs]
    .filter(fvg => !fvg.filled && fvg.type === htfBias)
    .sort((a, b) => {
      // 按距离当前价格排序
      const distA = htfBias === 'bullish'
        ? currentPrice - a.fib22
        : a.fib22 - currentPrice;
      const distB = htfBias === 'bullish'
        ? currentPrice - b.fib22
        : b.fib22 - currentPrice;
      return distA - distB;
    });

  const bestFVG = fvgCandidates[0];
  if (bestFVG) {
    const isLong = htfBias === 'bullish';
    const entry = bestFVG.fib22;

    // 寻找合适的止损位
    const recentSwings = m15.swingPoints.slice(-5);
    const stopSwing = recentSwings.find(s =>
      isLong ? s.type === 'low' && s.price < bestFVG.low
            : s.type === 'high' && s.price > bestFVG.high
    );

    const stopLoss = stopSwing
      ? stopSwing.price * (isLong ? 0.998 : 1.002)
      : isLong ? bestFVG.low * 0.99 : bestFVG.high * 1.01;

    const risk = Math.abs(entry - stopLoss);
    const tp1 = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
    const tp2 = isLong ? entry + risk * 2.5 : entry - risk * 2.5;

    return {
      type: 'fvg',
      bias: htfBias,
      entryZone: { high: bestFVG.high, low: bestFVG.low },
      suggestedEntry: entry,
      stopLoss,
      takeProfits: [tp1, tp2],
      riskReward: 2,
    };
  }

  return null;
}

/**
 * 生成分析摘要
 */
function generateSummary(analysis: MTFAnalysis): string {
  const lines: string[] = [];

  // HTF 分析
  lines.push(`【HTF 分析】`);
  lines.push(`  日线: ${analysis.htf.daily.trend} (${analysis.htf.daily.structure})`);
  lines.push(`  4H: ${analysis.htf.h4.trend} (${analysis.htf.h4.structure})`);
  lines.push(`  偏向: ${analysis.htf.bias} | 对齐: ${analysis.htf.aligned ? '是' : '否'}`);

  // MTF 分析
  lines.push(`【MTF 分析】`);
  lines.push(`  1H: ${analysis.mtf.h1.trend} (${analysis.mtf.h1.structure})`);
  lines.push(`  确认HTF: ${analysis.mtf.confirmed ? '是' : '否'}`);

  // LTF 入场
  if (analysis.ltf.entry) {
    const e = analysis.ltf.entry;
    lines.push(`【LTF 入场】`);
    lines.push(`  类型: ${e.type.toUpperCase()}`);
    lines.push(`  入场区: ${e.entryZone.low.toFixed(0)} - ${e.entryZone.high.toFixed(0)}`);
    lines.push(`  建议入场: ${e.suggestedEntry.toFixed(2)}`);
    lines.push(`  止损: ${e.stopLoss.toFixed(2)}`);
    lines.push(`  盈亏比: ${e.riskReward}`);
  } else {
    lines.push(`【LTF 入场】无有效入场点`);
  }

  // 结论
  lines.push(`【结论】`);
  lines.push(`  可交易: ${analysis.tradeable ? '是' : '否'}`);
  lines.push(`  对齐度: ${analysis.alignment}%`);

  return lines.join('\n');
}

// ============================================
// 主分析函数
// ============================================

/**
 * 执行多时间框架综合分析
 */
export async function analyzeMultiTimeframe(symbol: string): Promise<MTFAnalysis> {
  console.log(`[MTF] 开始分析 ${symbol}...`);

  // 1. 并行获取所有时间框架的 K 线数据
  const [dailyCandles, h4Candles, h1Candles, m15Candles, m5Candles] = await Promise.all([
    fetchKlines(symbol, '1d', 100),
    fetchKlines(symbol, '4h', 150),
    fetchKlines(symbol, '1h', 200),
    fetchKlines(symbol, '15m', 200),
    fetchKlines(symbol, '5m', 200),
  ]);

  const currentPrice = m5Candles[m5Candles.length - 1].close;

  // 2. 分析各个时间框架
  const dailyICT = analyzeICT(dailyCandles, symbol, '1d');
  const h4ICT = analyzeICT(h4Candles, symbol, '4h');
  const h1ICT = analyzeICT(h1Candles, symbol, '1h');
  const m15ICT = analyzeICT(m15Candles, symbol, '15m');
  const m5ICT = analyzeICT(m5Candles, symbol, '5m');

  const dailyTF = analyzeTimeframe(dailyICT);
  const h4TF = analyzeTimeframe(h4ICT);
  const h1TF = analyzeTimeframe(h1ICT);
  const m15TF = analyzeTimeframe(m15ICT);
  const m5TF = analyzeTimeframe(m5ICT);

  // 3. HTF 分析
  const htfResult = analyzeHTF(dailyTF, h4TF);
  console.log(`[MTF] HTF 偏向: ${htfResult.bias}, 对齐: ${htfResult.aligned}`);

  // 4. MTF 分析
  const mtfResult = analyzeMTF(h1TF, htfResult.bias);
  console.log(`[MTF] MTF 确认: ${mtfResult.confirmed}`);

  // 5. LTF 入场
  let ltfEntry: EntrySetup | null = null;
  if (htfResult.bias !== 'neutral' && mtfResult.confirmed) {
    ltfEntry = findLTFEntry(m15ICT, m5ICT, htfResult.bias, currentPrice);
    if (ltfEntry) {
      console.log(`[MTF] LTF 入场: ${ltfEntry.type} @ ${ltfEntry.suggestedEntry.toFixed(2)}`);
    }
  }

  // 6. 计算对齐度
  let alignment = 0;
  if (htfResult.bias !== 'neutral') {
    alignment += 30;  // HTF 有方向
    if (htfResult.aligned) alignment += 20;  // 日线和4H 对齐
    if (mtfResult.confirmed) alignment += 30;  // 1H 确认
    if (ltfEntry) alignment += 20;  // 有入场机会
  }

  // 7. 构建结果
  const analysis: MTFAnalysis = {
    symbol,
    timestamp: Date.now(),
    currentPrice,
    htf: {
      daily: dailyTF,
      h4: h4TF,
      bias: htfResult.bias,
      aligned: htfResult.aligned,
    },
    mtf: {
      h1: h1TF,
      confirmed: mtfResult.confirmed,
    },
    ltf: {
      m15: m15TF,
      m5: m5TF,
      entry: ltfEntry,
    },
    // 原始 K 线数据供 AI 分析形态
    klines: {
      h1: h1Candles.slice(-24),    // 最近 24 根 (24 小时)
      m15: m15Candles.slice(-16),  // 最近 16 根 (4 小时)
      m5: m5Candles.slice(-12),    // 最近 12 根 (1 小时)
    },
    overallBias: htfResult.bias,
    alignment,
    tradeable: htfResult.bias !== 'neutral' && mtfResult.confirmed && ltfEntry !== null,
    summary: '',
  };

  analysis.summary = generateSummary(analysis);
  console.log(`[MTF] 分析完成: 可交易=${analysis.tradeable}, 对齐度=${alignment}%`);

  return analysis;
}
