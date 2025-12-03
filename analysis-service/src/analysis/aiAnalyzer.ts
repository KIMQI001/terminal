/**
 * AI 分析模块
 * 支持多个 AI 提供商：Gemini, Claude, OpenAI, DeepSeek
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config';
import { ICTAnalysisResult } from './ictAnalyzer';
import { LiquidationData, extractKeyLiquidationLevels } from '../data/liquidationClient';
import { MTFAnalysis } from './mtfAnalyzer';
import { Candle } from '../data/klineClient';

// ============================================
// 类型定义
// ============================================

export interface TradeSignal {
  direction: 'long' | 'short' | 'neutral';
  confidence: 'high' | 'medium' | 'low';
  entry: {
    price: number;
    zone: string;
  };
  stopLoss: {
    price: number;
    reason: string;
  };
  takeProfit: Array<{
    price: number;
    reason: string;
  }>;
  riskReward: number;
  reasoning: string;
  warnings: string[];
}

// ============================================
// AI 客户端接口
// ============================================

interface AIClient {
  generateContent(prompt: string): Promise<string>;
  getName(): string;
}

// ============================================
// Gemini 客户端
// ============================================

class GeminiClient implements AIClient {
  private client: GoogleGenerativeAI;
  private model: string;

  constructor() {
    this.client = new GoogleGenerativeAI(config.ai.apiKey);
    this.model = config.ai.model || config.ai.defaultModels.gemini;
  }

  async generateContent(prompt: string): Promise<string> {
    const model = this.client.getGenerativeModel({ model: this.model });
    const result = await model.generateContent(prompt);
    return result.response.text();
  }

  getName(): string {
    return `Gemini (${this.model})`;
  }
}

// ============================================
// Claude 客户端
// ============================================

class ClaudeClient implements AIClient {
  private client: Anthropic;
  private model: string;

  constructor() {
    this.client = new Anthropic({ apiKey: config.ai.apiKey });
    this.model = config.ai.model || config.ai.defaultModels.claude;
  }

  async generateContent(prompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: config.ai.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Claude 响应格式错误');
    }
    return content.text;
  }

  getName(): string {
    return `Claude (${this.model})`;
  }
}

// ============================================
// OpenAI 客户端 (也用于 DeepSeek)
// ============================================

class OpenAIClient implements AIClient {
  private client: OpenAI;
  private model: string;
  private providerName: string;

  constructor(provider: 'openai' | 'deepseek') {
    const baseURL = provider === 'deepseek'
      ? 'https://api.deepseek.com/v1'
      : undefined;

    this.client = new OpenAI({
      apiKey: config.ai.apiKey,
      baseURL,
    });
    this.model = config.ai.model || config.ai.defaultModels[provider];
    this.providerName = provider === 'deepseek' ? 'DeepSeek' : 'OpenAI';
  }

  async generateContent(prompt: string): Promise<string> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: config.ai.maxTokens,
          messages: [{ role: 'user', content: prompt }],
        });
        return response.choices[0]?.message?.content || '';
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          console.log(`[AI] 请求失败，第 ${attempt + 1} 次重试...`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  getName(): string {
    return `${this.providerName} (${this.model})`;
  }
}

// ============================================
// AI 客户端工厂
// ============================================

function createAIClient(): AIClient {
  switch (config.ai.provider) {
    case 'gemini':
      return new GeminiClient();
    case 'claude':
      return new ClaudeClient();
    case 'openai':
      return new OpenAIClient('openai');
    case 'deepseek':
      return new OpenAIClient('deepseek');
    default:
      throw new Error(`不支持的 AI 提供商: ${config.ai.provider}`);
  }
}

// 单例客户端
let aiClient: AIClient | null = null;

function getAIClient(): AIClient {
  if (!aiClient) {
    aiClient = createAIClient();
    console.log(`[AI] 初始化 ${aiClient.getName()}`);
  }
  return aiClient;
}

// ============================================
// 调用计数器
// ============================================

let hourlyCallCount = 0;
let dailyCallCount = 0;
let lastHourReset = Date.now();
let lastDayReset = Date.now();

function checkAndResetCounters(): void {
  const now = Date.now();

  if (now - lastHourReset > 60 * 60 * 1000) {
    hourlyCallCount = 0;
    lastHourReset = now;
  }

  if (now - lastDayReset > 24 * 60 * 60 * 1000) {
    dailyCallCount = 0;
    lastDayReset = now;
  }
}

export function canCallAI(): { allowed: boolean; reason?: string } {
  checkAndResetCounters();

  if (hourlyCallCount >= config.ai.maxCallsPerHour) {
    return { allowed: false, reason: `已达到每小时限制 (${config.ai.maxCallsPerHour})` };
  }

  if (dailyCallCount >= config.ai.maxCallsPerDay) {
    return { allowed: false, reason: `已达到每日限制 (${config.ai.maxCallsPerDay})` };
  }

  return { allowed: true };
}

// ============================================
// 生成交易信号
// ============================================

export async function generateTradeSignal(
  ictResult: ICTAnalysisResult,
  liquidationData: LiquidationData | null
): Promise<TradeSignal | null> {
  const check = canCallAI();
  if (!check.allowed) {
    console.log(`[AI] 跳过分析: ${check.reason}`);
    return null;
  }

  hourlyCallCount++;
  dailyCallCount++;

  try {
    const client = getAIClient();
    const prompt = buildPrompt(ictResult, liquidationData);

    console.log(`[AI] 使用 ${client.getName()} 分析 ${ictResult.symbol}@${ictResult.timeframe}...`);

    const responseText = await client.generateContent(prompt);
    return parseAIResponse(responseText);
  } catch (error) {
    console.error('[AI] 调用失败:', error);
    return null;
  }
}

// ============================================
// 构建 AI Prompt
// ============================================

function buildPrompt(ict: ICTAnalysisResult, liq: LiquidationData | null): string {
  let liquidationInfo = '';
  if (liq) {
    const keyLevels = extractKeyLiquidationLevels(liq, ict.currentPrice, 3);
    liquidationInfo = `
## 清算数据
### 多头清算密集区（价格下方）
${keyLevels.longLiquidation.map(l => `- $${l.price.toFixed(2)}: ${(l.amount / 1e6).toFixed(2)}M USD`).join('\n') || '无显著水平'}

### 空头清算密集区（价格上方）
${keyLevels.shortLiquidation.map(l => `- $${l.price.toFixed(2)}: ${(l.amount / 1e6).toFixed(2)}M USD`).join('\n') || '无显著水平'}
`;
  }

  return `你是一位专业的 ICT (Inner Circle Trader) 交易分析师。请根据以下市场数据生成交易建议。

## 当前市场状态
- 交易对: ${ict.symbol}
- 时间周期: ${ict.timeframe}
- 当前价格: $${ict.currentPrice.toFixed(2)}
- 趋势判断: ${ict.trend}

## ICT 指标数据

### Swing Points（最近5个）
${ict.swingPoints
  .slice(-5)
  .map(s => `- ${s.type.toUpperCase()}: $${s.price.toFixed(2)}`)
  .join('\n')}

### Fair Value Gaps (未填充，最近15个)
${
  ict.fvgs
    .filter(f => !f.filled)
    .slice(-15)
    .map(f => `- ${f.type.toUpperCase()} FVG: $${f.low.toFixed(2)}-$${f.high.toFixed(2)}, 入场: $${f.entry.toFixed(2)}, 止损: $${f.stopLoss.toFixed(2)}`)
    .join('\n') || '无活跃 FVG'
}

### Order Blocks (最近10个)
${
  ict.orderBlocks
    .slice(-10)
    .map(ob => {
      const size = ob.high - ob.low;
      const entry = ob.type === 'bullish' ? ob.high - size * 0.22 : ob.low + size * 0.22;
      const stopLoss = ob.type === 'bullish' ? ob.low : ob.high;
      return `- ${ob.type.toUpperCase()} OB: $${ob.low.toFixed(2)}-$${ob.high.toFixed(2)}, 入场: $${entry.toFixed(2)}, 止损: $${stopLoss.toFixed(2)}`;
    })
    .join('\n') || '无活跃 OB'
}

### OTE 区域
${
  ict.oteZones
    .map(
      z =>
        `- ${z.type.toUpperCase()} OTE: ${z.active ? '[活跃]' : ''}
    入场: $${z.entry.toFixed(2)} (67.5%)
    止损: $${z.stopLoss.toFixed(2)} (>78.6%)
    区间: 61.8%=$${z.fib618.toFixed(2)}, 78.6%=$${z.fib786.toFixed(2)}`
    )
    .join('\n') || '无活跃 OTE'
}

### 市场结构
- 最近 BOS: ${ict.bos.slice(-2).map(b => `${b.type} @ $${b.level.toFixed(2)}`).join(', ') || '无'}
- 最近 CHoCH: ${ict.choch.slice(-1).map(c => `${c.type} @ $${c.level.toFixed(2)} (之前趋势: ${c.previousTrend})`).join(', ') || '无'}

${liquidationInfo}

## 请提供交易建议

请以 JSON 格式返回，包含以下字段：
{
  "direction": "long" | "short" | "neutral",
  "confidence": "high" | "medium" | "low",
  "entry": {
    "price": 数字,
    "zone": "入场区域说明"
  },
  "stopLoss": {
    "price": 数字,
    "reason": "止损原因"
  },
  "takeProfit": [
    { "price": 数字, "reason": "止盈原因" }
  ],
  "riskReward": 风险回报比数字,
  "reasoning": "详细分析理由",
  "warnings": ["风险提示1", "风险提示2"]
}

## 交易偏好（请参考）

- FVG 入场: 0.22 位置，止损放边界
- OB 入场: 0.22 位置，止损放边界
- OTE 入场: 0.675 位置，止损放 0.786 外侧

注意事项：
1. 如果没有明确的交易机会，direction 设为 "neutral"
2. 止损应该放在关键结构位之外
3. 考虑清算密集区作为潜在的流动性猎取目标
4. 风险回报比至少 1:2 才考虑交易
5. 优先使用上面预计算好的入场和止损价格`;
}

// ============================================
// 解析 AI 响应
// ============================================

function parseAIResponse(text: string): TradeSignal | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[AI] 无法提取 JSON');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.direction || !parsed.confidence) {
      console.error('[AI] 响应缺少必要字段');
      return null;
    }

    if (parsed.direction === 'neutral') {
      return {
        direction: 'neutral',
        confidence: parsed.confidence,
        entry: { price: 0, zone: '观望' },
        stopLoss: { price: 0, reason: '无' },
        takeProfit: [],
        riskReward: 0,
        reasoning: parsed.reasoning || '当前没有明确的交易机会',
        warnings: parsed.warnings || [],
      };
    }

    return {
      direction: parsed.direction,
      confidence: parsed.confidence,
      entry: parsed.entry || { price: 0, zone: '未指定' },
      stopLoss: parsed.stopLoss || { price: 0, reason: '未指定' },
      takeProfit: parsed.takeProfit || [],
      riskReward: parsed.riskReward || 0,
      reasoning: parsed.reasoning || '',
      warnings: parsed.warnings || [],
    };
  } catch (error) {
    console.error('[AI] 解析响应失败:', error);
    return null;
  }
}

// ============================================
// MTF 多时间框架分析
// ============================================

/**
 * 格式化时间戳为可读时间
 */
function formatKlineTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).replace(/\//g, '-');
}

/**
 * 格式化 K 线数据为紧凑表格
 */
function formatKlines(candles: Candle[], label: string): string {
  if (!candles || candles.length === 0) return '';

  const lines = candles.map(c => {
    const change = ((c.close - c.open) / c.open * 100).toFixed(2);
    const emoji = c.close >= c.open ? '🟢' : '🔴';
    const changeStr = Number(change) >= 0 ? `+${change}` : change;
    return `| ${emoji} | ${formatKlineTime(c.time)} | ${c.open.toFixed(0)} | ${c.high.toFixed(0)} | ${c.low.toFixed(0)} | ${c.close.toFixed(0)} | ${changeStr}% |`;
  });

  return `### ${label} K线 (最近 ${candles.length} 根)
| 方向 | 时间 | 开盘 | 最高 | 最低 | 收盘 | 涨跌 |
|:----:|:----:|-----:|-----:|-----:|-----:|-----:|
${lines.join('\n')}`;
}

/**
 * 构建 MTF 分析 Prompt
 */
function buildMTFPrompt(mtf: MTFAnalysis, liq: LiquidationData | null): string {
  let liquidationInfo = '';
  if (liq) {
    const keyLevels = extractKeyLiquidationLevels(liq, mtf.currentPrice, 3);
    liquidationInfo = `
## 清算数据
### 多头清算密集区（价格下方）
${keyLevels.longLiquidation.map(l => `- $${l.price.toFixed(2)}: ${(l.amount / 1e6).toFixed(2)}M USD`).join('\n') || '无显著水平'}

### 空头清算密集区（价格上方）
${keyLevels.shortLiquidation.map(l => `- $${l.price.toFixed(2)}: ${(l.amount / 1e6).toFixed(2)}M USD`).join('\n') || '无显著水平'}
`;
  }

  // 格式化入场设置信息
  let entryInfo = '无有效入场点';
  if (mtf.ltf.entry) {
    const e = mtf.ltf.entry;
    entryInfo = `
- 类型: ${e.type.toUpperCase()}
- 方向: ${e.bias}
- 入场区间: $${e.entryZone.low.toFixed(2)} - $${e.entryZone.high.toFixed(2)}
- 建议入场: $${e.suggestedEntry.toFixed(2)}
- 止损: $${e.stopLoss.toFixed(2)}
- 止盈目标: ${e.takeProfits.map(tp => `$${tp.toFixed(2)}`).join(', ')}
- 预期盈亏比: ${e.riskReward}`;
  }

  return `你是一位专业的 ICT (Inner Circle Trader) 交易分析师，使用自上而下的多时间框架分析方法。

## 多时间框架分析结果

### 当前市场状态
- 交易对: ${mtf.symbol}
- 当前价格: $${mtf.currentPrice.toFixed(2)}
- 综合偏向: ${mtf.overallBias}
- 时间框架对齐度: ${mtf.alignment}%
- 可交易: ${mtf.tradeable ? '是' : '否'}

### 高时间框架 (HTF: 1D + 4H) - 确定方向
- 日线趋势: ${mtf.htf.daily.trend}
- 日线结构: ${mtf.htf.daily.structure}${mtf.htf.daily.structureType ? ` (${mtf.htf.daily.structureType})` : ''}
- 4H趋势: ${mtf.htf.h4.trend}
- 4H结构: ${mtf.htf.h4.structure}${mtf.htf.h4.structureType ? ` (${mtf.htf.h4.structureType})` : ''}
- HTF偏向: ${mtf.htf.bias}
- 日线与4H对齐: ${mtf.htf.aligned ? '是' : '否'}

### 中时间框架 (MTF: 1H) - 确认结构
- 1H趋势: ${mtf.mtf.h1.trend}
- 1H结构: ${mtf.mtf.h1.structure}${mtf.mtf.h1.structureType ? ` (${mtf.mtf.h1.structureType})` : ''}
- 确认HTF方向: ${mtf.mtf.confirmed ? '是' : '否'}

### 低时间框架 (LTF: 15M/5M) - 入场机会
- 15M趋势: ${mtf.ltf.m15.trend}
- 5M趋势: ${mtf.ltf.m5.trend}
- 入场设置:
${entryInfo}

${liquidationInfo}

## K线数据（用于形态分析）

${formatKlines(mtf.klines.h1, '1H')}

${formatKlines(mtf.klines.m15, '15M')}

${formatKlines(mtf.klines.m5, '5M')}

**请结合 K 线形态（如吞没、Pin Bar、内包、Doji、锤子线等）与 ICT 指标进行综合分析。**

## 请提供交易建议

基于以上多时间框架分析，请以 JSON 格式返回交易建议：
{
  "direction": "long" | "short" | "neutral",
  "confidence": "high" | "medium" | "low",
  "entry": {
    "price": 数字,
    "zone": "入场区域说明"
  },
  "stopLoss": {
    "price": 数字,
    "reason": "止损原因"
  },
  "takeProfit": [
    { "price": 数字, "reason": "止盈原因" }
  ],
  "riskReward": 风险回报比数字,
  "reasoning": "详细分析理由（包含各时间框架的分析）",
  "warnings": ["风险提示1", "风险提示2"]
}

## 交易偏好（请参考）

- FVG 入场: 0.22 位置，止损放边界
- OB 入场: 0.22 位置，止损放边界
- OTE 入场: 0.675 位置，止损放 0.786 外侧

## 重要规则

仅当以下条件**全部满足**时才建议交易（direction 设为 long 或 short）：
1. HTF 方向明确（非 neutral）
2. MTF（1H）结构确认 HTF 方向
3. LTF 出现有效入场机会（OTE 或 FVG）
4. 对齐度 >= 50%

如果以上条件**任一不满足**，必须返回 direction: "neutral"。

置信度规则：
- high: 对齐度 >= 80%，所有时间框架趋势一致
- medium: 对齐度 50-79%，主要时间框架对齐
- low: 对齐度 < 50%（此时应返回 neutral）

注意：优先使用上面预计算好的入场和止损价格。`;
}

/**
 * 生成 MTF 综合交易信号
 */
export async function generateMTFSignal(
  mtfAnalysis: MTFAnalysis,
  liquidationData: LiquidationData | null
): Promise<TradeSignal | null> {
  const check = canCallAI();
  if (!check.allowed) {
    console.log(`[AI] 跳过 MTF 分析: ${check.reason}`);
    return null;
  }

  // 如果对齐度太低，直接返回 neutral
  if (mtfAnalysis.alignment < 50) {
    console.log(`[AI] MTF 对齐度过低 (${mtfAnalysis.alignment}%)，跳过 AI 调用`);
    return {
      direction: 'neutral',
      confidence: 'low',
      entry: { price: 0, zone: '观望' },
      stopLoss: { price: 0, reason: '无' },
      takeProfit: [],
      riskReward: 0,
      reasoning: `多时间框架对齐度不足 (${mtfAnalysis.alignment}%)，建议观望`,
      warnings: ['时间框架未对齐', '等待更明确的信号'],
    };
  }

  hourlyCallCount++;
  dailyCallCount++;

  try {
    const client = getAIClient();
    const prompt = buildMTFPrompt(mtfAnalysis, liquidationData);

    console.log(`[AI] 使用 ${client.getName()} 执行 MTF 分析 ${mtfAnalysis.symbol}...`);

    const responseText = await client.generateContent(prompt);
    return parseAIResponse(responseText);
  } catch (error) {
    console.error('[AI] MTF 分析调用失败:', error);
    return null;
  }
}

// ============================================
// 工具函数
// ============================================

export function getCallStats(): { hourly: number; daily: number } {
  checkAndResetCounters();
  return { hourly: hourlyCallCount, daily: dailyCallCount };
}

export function getProviderInfo(): string {
  return getAIClient().getName();
}
