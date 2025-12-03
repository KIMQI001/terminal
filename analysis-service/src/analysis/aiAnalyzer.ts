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
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: config.ai.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.choices[0]?.message?.content || '';
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

### Fair Value Gaps (未填充)
${
  ict.fvgs
    .filter(f => !f.filled)
    .slice(0, 3)
    .map(f => `- ${f.type.toUpperCase()} FVG: $${f.low.toFixed(2)} - $${f.high.toFixed(2)}, 入场点: $${f.fib22.toFixed(2)}`)
    .join('\n') || '无活跃 FVG'
}

### OTE 区域
${
  ict.oteZones
    .map(
      z =>
        `- ${z.type.toUpperCase()} OTE: 61.8%=$${z.fib618.toFixed(2)}, 67.5%=$${z.fib675.toFixed(2)}, 78.6%=$${z.fib786.toFixed(2)} ${z.active ? '[活跃]' : ''}`
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

注意事项：
1. 如果没有明确的交易机会，direction 设为 "neutral"
2. 止损应该放在关键结构位之外
3. 考虑清算密集区作为潜在的流动性猎取目标
4. 风险回报比至少 1:2 才考虑交易`;
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
// 工具函数
// ============================================

export function getCallStats(): { hourly: number; daily: number } {
  checkAndResetCounters();
  return { hourly: hourlyCallCount, daily: dailyCallCount };
}

export function getProviderInfo(): string {
  return getAIClient().getName();
}
