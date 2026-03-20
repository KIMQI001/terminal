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
import { Candle, fetchKlines } from '../data/klineClient';
import { getRecentPerformance, getAdjustedRRThreshold } from '../signals/signalStore';

// ============================================
// 类型定义
// ============================================

export interface TradeSignal {
  direction: 'long' | 'short' | 'neutral';
  confidence: 'high' | 'medium' | 'low';
  entry: {
    price: number;
    zone: string;  // 现在包含 range，如 "$69,000-$70,000"
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
  // 新增字段
  entryCondition?: string;  // 入场条件
  keyLevels?: {
    support: number[];
    resistance: number[];
    pdHigh: number;
    pdLow: number;
  };
  // AI 推荐相关
  summary?: string;
  recommendations?: Array<{
    rank: number;
    direction: 'long' | 'short';
    entryZone: { low: number; high: number };
    entryCondition: string;
    stopLoss: { price: number; reason: string };
    takeProfit: { price: number; reason: string };
    riskReward: number;
    htfBias?: string;
    ictConfirmation?: string[];
    liquidationTarget?: string;
  }>;
  avoid?: {
    direction: 'long' | 'short' | 'neutral';
    reason: string;
  };
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
// MiniMax 客户端
// ============================================

class MiniMaxClient implements AIClient {
  private apiKey: string;

  constructor() {
    this.apiKey = config.ai.apiKey;
  }

  async generateContent(prompt: string): Promise<string> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    // MiniMax Token Plan 使用 Anthropic 兼容 API
    const url = 'https://api.minimaxi.com/anthropic/v1/messages';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config.ai.model || config.ai.defaultModels.minimax,
            max_tokens: config.ai.maxTokens,
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`MiniMax API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json() as {
          thinking?: string;
          content?: Array<{ type?: string; text?: string; thinking?: string }>;
          error?: { message?: string };
        };

        if (data.error) {
          throw new Error(data.error.message || 'MiniMax API error');
        }

        // 打印完整返回便于调试
        console.log(`[AI] MiniMax 返回结构:`, JSON.stringify(data).substring(0, 2000));

        // MiniMax thinking 模型的响应结构:
        // - content 中包含多个元素，每个元素有 type 字段
        // - type='thinking': 包含 AI 的推理过程（中文解释）
        // - type='text': 包含实际的 JSON 输出

        let text = '';

        // 1. 从 content 数组中找所有 type='text' 的元素
        const textContents = data.content?.filter(c => c.type === 'text');
        if (textContents && textContents.length > 0) {
          text = textContents[textContents.length - 1].text || '';
        }

        // 2. 如果没找到，尝试直接从 content 数组中找任何有 text 字段的元素
        if (!text && data.content) {
          for (const item of data.content) {
            if (item.text) {
              text = item.text;
              break;
            }
          }
        }

        // 3. 如果还是没有，尝试从 thinking 末尾提取 JSON
        if (!text && data.content) {
          const thinking = data.content.find(c => c.type === 'thinking')?.thinking || '';
          // 从 thinking 末尾提取 JSON
          const jsonMatch = thinking.match(/\{[\s\S]*\}$/);
          if (jsonMatch) {
            text = jsonMatch[0];
            console.log(`[AI] 从 thinking 末尾提取到 JSON，长度: ${text.length}`);
          }
        }

        console.log(`[AI] text 长度: ${text.length}`);

        return text;
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          console.log(`[AI] MiniMax 请求失败，第 ${attempt + 1} 次重试...`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  getName(): string {
    return `MiniMax (${config.ai.model || config.ai.defaultModels.minimax})`;
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
    case 'minimax':
      return new MiniMaxClient();
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
    console.log(`[AI] 原始返回: ${responseText.substring(0, 500)}`);
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

### Fair Value Gaps (按填充度排序，优先推荐低填充)
${
  ict.fvgs
    .filter(f => !f.filled)
    .sort((a, b) => a.fillPercentage - b.fillPercentage)  // 低填充优先
    .slice(0, 15)
    .map(f => `- ${f.type.toUpperCase()} FVG: $${f.low.toFixed(2)}-$${f.high.toFixed(2)}, 填充: ${f.fillPercentage.toFixed(0)}%, 入场: $${f.entry.toFixed(2)}, 止损: $${f.stopLoss.toFixed(2)}`)
    .join('\n') || '无活跃 FVG'
}

### Order Blocks (按填充度排序，优先推荐低填充)
${
  ict.orderBlocks
    .filter(ob => !ob.mitigated && ob.fillPercentage < 80)
    .sort((a, b) => a.fillPercentage - b.fillPercentage)  // 低填充优先
    .slice(0, 10)
    .map(ob => {
      const stopLoss = ob.type === 'bullish' ? ob.low : ob.high;
      return `- ${ob.type.toUpperCase()} OB: $${ob.low.toFixed(2)}-$${ob.high.toFixed(2)}, 填充: ${ob.fillPercentage.toFixed(0)}%, 入场: $${ob.fib22.toFixed(2)}, 止损: $${stopLoss.toFixed(2)}`;
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
    "zone": "简短入场区域说明"
  },
  "stopLoss": {
    "price": 数字,
    "reason": "简短止损原因"
  },
  "takeProfit": [
    { "price": 数字, "reason": "简短止盈原因" }
  ],
  "riskReward": 风险回报比数字,
  "reasoning": "简短分析理由",
  "warnings": ["简短风险提示"]
}

**重要：reason 字段必须简洁，不超过20个字符，确保 JSON 完整输出！**

## 守塔止盈止损规则（必须严格遵守）

- **止损规则**：多单止损 = 入场价 × 0.997 ~ 0.998，空单止损 = 入场价 × 1.002 ~ 1.003，止损最大不能超过入场价的 ±0.3%
- **止盈规则**：止盈目标 = 入场价 ± 5%（多单 +, 空单 -）
- **RR 要求**：止盈距离 / 止损距离，必须 >= 15
- **入场优先**：OTE 0.675 位置（止损放 0.786 外侧）、FVG 填充区（止损放边界）、OB 0.22 位置（止损放边界）
- **重要**：如果计算出的止损距离导致 RR < 15，必须调整入场位置或放弃该交易

**重要**：如果 RR < 15 或任一条件不满足，必须返回 direction: "neutral"。`;
}

// ============================================
// 解析 AI 响应
// ============================================

function parseAIResponse(text: string): TradeSignal | null {
  try {
    let jsonText = '';

    // 尝试从 ```json 代码块中提取
    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1].trim();
      console.log('[AI] 从代码块提取到 JSON，长度:', jsonText.length);
    } else {
      // 尝试匹配 JSON 对象
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
        console.log('[AI] 从文本提取到 JSON，长度:', jsonText.length);
      } else {
        console.log('[AI] 未找到 JSON 格式，text 内容:', text.substring(0, 200));
      }
    }

    if (jsonText) {
      // 尝试解析，如果失败则尝试修复截断的 JSON
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (e) {
        const fixed = fixTruncatedJSON(jsonText);
        if (fixed) {
          console.log('[AI] JSON 被截断，已自动修复');
          parsed = JSON.parse(fixed);
        } else {
          throw e;
        }
      }

      // 新格式：有 summary 和 recommendations
      if (parsed.summary || parsed.recommendations) {
        // 从 recommendations 推断方向
        let direction: 'long' | 'short' | 'neutral' = 'neutral';
        if (parsed.recommendations?.length > 0) {
          direction = parsed.recommendations[0].direction || 'neutral';
        }

        // 解析 recommendations 中的入场区间
        const recommendations = parsed.recommendations?.map((rec: any) => {
          // entryZone 可能是 "$68000-$69000" 格式
          let entryZone = { low: 0, high: 0 };
          if (typeof rec.entryZone === 'string') {
            const match = rec.entryZone.match(/\$(\d+)[-,]?\s*\$?(\d+)?/);
            if (match) {
              entryZone.low = parseInt(match[1]);
              entryZone.high = match[2] ? parseInt(match[2]) : entryZone.low;
            }
          } else if (rec.entryZone?.low && rec.entryZone?.high) {
            entryZone = rec.entryZone;
          }

          return {
            rank: rec.rank || 1,
            direction: rec.direction || 'neutral',
            entryZone,
            entryCondition: rec.entryCondition || rec.reason || '',
            stopLoss: { price: parseFloat(String(rec.stopLoss).replace(/[$,]/g, '')) || 0, reason: rec.stopLossReason || rec.reason || '' },
            takeProfit: { price: parseFloat(String(rec.takeProfit).replace(/[$,]/g, '')) || 0, reason: rec.takeProfitReason || rec.reason || '' },
            riskReward: rec.rr || rec.riskReward || 0,
            htfBias: rec.htfBias || '',
            ictConfirmation: rec.ictConfirmation || [],
            liquidationTarget: rec.liquidationTarget || '',
          };
        }) || [];

        return {
          direction,
          confidence: parsed.confidence || (recommendations.length > 0 ? 'medium' : 'low'),
          entry: { price: 0, zone: parsed.summary || '见推荐' },
          stopLoss: { price: 0, reason: '见推荐' },
          takeProfit: [],
          riskReward: recommendations[0]?.riskReward || 0,
          reasoning: parsed.summary || '',
          warnings: [],
          summary: parsed.summary || '',
          recommendations,
          avoid: parsed.avoid,
          keyLevels: parsed.keyLevels,
        };
      }

      // 旧格式：有 direction 和 confidence
      if (parsed.direction && parsed.confidence) {
        return {
          direction: parsed.direction || 'neutral',
          confidence: parsed.confidence || 'low',
          entry: parsed.entryZone ? {
            price: (parsed.entryZone.low + parsed.entryZone.high) / 2,
            zone: `$${parsed.entryZone.low.toFixed(0)}-$ ${parsed.entryZone.high.toFixed(0)}`,
          } : parsed.entry || { price: 0, zone: '观望' },
          stopLoss: parsed.stopLoss || { price: 0, reason: '无' },
          takeProfit: parsed.takeProfit || [],
          riskReward: parsed.riskReward || 0,
          reasoning: parsed.reasoning || '',
          warnings: parsed.warnings || [],
          entryCondition: parsed.entryZone?.condition || '',
          keyLevels: parsed.keyLevels || undefined,
          summary: parsed.summary || '',
          recommendations: parsed.recommendations,
          avoid: parsed.avoid,
        };
      }
    }

    // 如果没有 JSON，尝试从文本中提取关键信息
    console.log('[AI] 未找到有效 JSON，尝试从文本提取...');
    const summary = text.substring(0, 500);

    // 尝试提取方向关键词
    let direction: 'long' | 'short' | 'neutral' = 'neutral';
    if (/做多|long|买入|buy/i.test(text) && !/不做多|不做多|不要多|别多/i.test(text)) {
      direction = 'long';
    } else if (/做空|short|卖出|sell/i.test(text) && !/不做空|不做空|不要空|别空/i.test(text)) {
      direction = 'short';
    }

    return {
      direction,
      confidence: 'low',
      entry: { price: 0, zone: '需人工确认' },
      stopLoss: { price: 0, reason: '无' },
      takeProfit: [],
      riskReward: 0,
      reasoning: summary,
      warnings: ['AI 未返回标准 JSON，建议人工确认'],
      summary: summary,
    };
  } catch (error) {
    console.error('[AI] 解析响应失败:', error);
    return null;
  }
}

/**
 * 修复被截断的 JSON
 * 补全缺失的括号、引号等
 */
function fixTruncatedJSON(jsonText: string): string | null {
  try {
    // 统计括号深度
    let braceCount = 0;
    let bracketCount = 0;
    let parenCount = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < jsonText.length; i++) {
      const char = jsonText[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"' && !escaped) {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
      else if (char === '(') parenCount++;
      else if (char === ')') parenCount--;
    }

    // 如果括号平衡，不需要修复
    if (braceCount === 0 && bracketCount === 0 && parenCount === 0) {
      return jsonText;
    }

    // 移除末尾不完整的部分（最后一个不完整的对象或数组元素）
    let fixed = jsonText;

    // 移除末尾截断的字符串（最后一个不完整的引号内容）
    const lastQuoteIndex = jsonText.lastIndexOf('"');
    const lastColonIndex = jsonText.lastIndexOf(':');
    const lastCommaIndex = jsonText.lastIndexOf(',');
    const lastBraceIndex = jsonText.lastIndexOf('}');
    const lastBracketIndex = jsonText.lastIndexOf(']');

    // 如果最后一个字符不是 } 或 ]，说明 JSON 被截断
    const trimmed = jsonText.trim();
    const lastChar = trimmed[trimmed.length - 1];

    if (lastChar !== '}' && lastChar !== ']') {
      // 找到最后一个完整的数组元素或对象属性
      // 移除不完整的部分
      const lastCompleteIndex = Math.max(
        trimmed.lastIndexOf(',"'),
        trimmed.lastIndexOf(']}'),
        trimmed.lastIndexOf(']')
      );

      if (lastCompleteIndex > 0) {
        fixed = trimmed.substring(0, lastCompleteIndex + 1);
      }
    }

    // 补全缺失的括号
    while (braceCount > 0) {
      fixed += '}';
      braceCount--;
    }
    while (bracketCount > 0) {
      fixed += ']';
      bracketCount--;
    }

    // 验证修复后的 JSON 是否有效
    JSON.parse(fixed);
    return fixed;
  } catch {
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
 * 构建 MTF 分析 Prompt - 高 RR 机会寻找模式
 */
/**
 * 格式化 ICT 关键价位
 */
function formatICTLevels(ict: ICTAnalysisResult, currentPrice: number): string {
  const parts: string[] = [];

  // Order Blocks（过滤离当前价格 5% 以内的）
  const nearbyOBs = ict.orderBlocks.filter(ob => {
    const obMid = (ob.high + ob.low) / 2;
    return Math.abs(obMid - currentPrice) / currentPrice < 0.05;
  });
  if (nearbyOBs.length > 0) {
    parts.push('### 附近 Order Blocks:');
    for (const ob of nearbyOBs.slice(0, 3)) {
      const mid = (ob.high + ob.low) / 2;
      const dist = ((mid - currentPrice) / currentPrice * 100).toFixed(2);
      const dir = ob.type === 'bullish' ? '多' : '空';
      parts.push(`  - ${dir}OB: $${ob.low.toFixed(2)} - $${ob.high.toFixed(2)} (中${~~mid}, ${dist}%)`);
    }
  }

  // FVGs（过滤离当前价格 3% 以内的）
  const nearbyFVGs = ict.fvgs.filter(fvg => {
    const fvgMid = (fvg.high + fvg.low) / 2;
    return Math.abs(fvgMid - currentPrice) / currentPrice < 0.03;
  });
  if (nearbyFVGs.length > 0) {
    parts.push('### 附近 FVGs:');
    for (const fvg of nearbyFVGs.slice(0, 3)) {
      const mid = (fvg.high + fvg.low) / 2;
      const dist = ((mid - currentPrice) / currentPrice * 100).toFixed(2);
      const fillType = fvg.type === 'bullish' ? '低填' : '高填';
      parts.push(`  - ${fvg.type === 'bullish' ? '多' : '空'}FVG(${fillType}): $${fvg.low.toFixed(2)} - $${fvg.high.toFixed(2)} (中${~~mid}, ${dist}%)`);
    }
  }

  // OTE Zones（过滤离当前价格 3% 以内的）
  const nearbyOTE = ict.oteZones.filter(ote => {
    return Math.abs(ote.fib675 - currentPrice) / currentPrice < 0.03;
  });
  if (nearbyOTE.length > 0) {
    parts.push('### 附近 OTE 入场区:');
    for (const ote of nearbyOTE.slice(0, 3)) {
      const dist = ((ote.fib675 - currentPrice) / currentPrice * 100).toFixed(2);
      parts.push(`  - ${ote.type === 'bullish' ? '多' : '空'}OTE: 0.786=${ote.fib786.toFixed(2)}, 0.618=${ote.fib618.toFixed(2)} (0.675=${ote.fib675.toFixed(2)}, 偏离${dist}%)`);
    }
  }

  // Swing Points
  const recentHighs = ict.swingPoints.filter(s => s.type === 'high').slice(-3);
  const recentLows = ict.swingPoints.filter(s => s.type === 'low').slice(-3);
  if (recentHighs.length > 0 || recentLows.length > 0) {
    parts.push('### 近期波段高低:');
    for (const h of recentHighs) {
      parts.push(`  - 高: $${h.price.toFixed(2)}`);
    }
    for (const l of recentLows) {
      parts.push(`  - 低: $${l.price.toFixed(2)}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : '无';
}

/**
 * 找到包含当前价格的锚定K线（与守塔策略一致）
 */
function findAnchorCandle(klines: Candle[], currentPrice: number): { high: number; low: number } | null {
  if (klines.length < 2) return null;
  const latestCandle = klines[klines.length - 1];

  // 从倒数第二根向左扫描，找到包含当前价格的K线
  for (let i = klines.length - 2; i >= 0; i--) {
    const { high, low } = klines[i];
    if (currentPrice >= low && currentPrice <= high) {
      return {
        high: Math.max(high, latestCandle.high),
        low: Math.min(low, latestCandle.low),
      };
    }
  }
  return null;
}

/**
 * 计算 P/D 区域（与守塔策略一致）
 * P = 高 - 区间/4 (溢价区)
 * D = 低 + 区间/4 (折扣区)
 */
function calculatePD(high: number, low: number): { pdHigh: number; pdLow: number } {
  const range = high - low;
  const quarterRange = range / 4;
  return {
    pdHigh: high - quarterRange,
    pdLow: low + quarterRange,
  };
}

/**
 * 计算 P/D（使用 4D 和 1D，取更保守的值）
 * P = max(4D.P, 1D.P) → 卖得更高
 * D = min(4D.D, 1D.D) → 买得更低
 */
interface PDPair {
  pdHigh: number;
  pdLow: number;
  source: string;
}

function computeConservativePD(
  fdKlines: Candle[],  // 4D K 线
  dailyKlines: Candle[], // 1D K 线
  currentPrice: number
): PDPair {
  // 尝试 4D 锚定
  const fdAnchor = findAnchorCandle(fdKlines, currentPrice);
  // 尝试 1D 锚定
  const dailyAnchor = findAnchorCandle(dailyKlines, currentPrice);

  let fdPD: PDPair | null = null;
  let dailyPD: PDPair | null = null;

  if (fdAnchor) {
    const pd = calculatePD(fdAnchor.high, fdAnchor.low);
    fdPD = { pdHigh: pd.pdHigh, pdLow: pd.pdLow, source: '4D' };
    console.log(`[AI] 4D锚定: high=${fdAnchor.high.toFixed(0)} low=${fdAnchor.low.toFixed(0)} P=${pd.pdHigh.toFixed(0)} D=${pd.pdLow.toFixed(0)}`);
  }

  if (dailyAnchor) {
    const pd = calculatePD(dailyAnchor.high, dailyAnchor.low);
    dailyPD = { pdHigh: pd.pdHigh, pdLow: pd.pdLow, source: '1D' };
    console.log(`[AI] 1D锚定: high=${dailyAnchor.high.toFixed(0)} low=${dailyAnchor.low.toFixed(0)} P=${pd.pdHigh.toFixed(0)} D=${pd.pdLow.toFixed(0)}`);
  }

  // 取更保守的值
  if (fdPD && dailyPD) {
    return {
      pdHigh: Math.max(fdPD.pdHigh, dailyPD.pdHigh),
      pdLow: Math.min(fdPD.pdLow, dailyPD.pdLow),
      source: `${fdPD.source}+${dailyPD.source}`,
    };
  } else if (fdPD) {
    return fdPD;
  } else if (dailyPD) {
    return dailyPD;
  }

  // 没有锚定，用 swing points 降级
  return { pdHigh: currentPrice * 1.05, pdLow: currentPrice * 0.95, source: 'fallback' };
}

function buildMTFPrompt(mtf: MTFAnalysis, dailyKlines: Candle[], liq: LiquidationData | null): string {
  const adjustedRR = getAdjustedRRThreshold(15, 7);

  // P/D 计算 - 使用守塔策略的锚定K线逻辑
  // 使用 4D 和 1D，取更保守的值
  const fdKlines = mtf.klines.fd || [];
  const pd = computeConservativePD(fdKlines, dailyKlines, mtf.currentPrice);
  const pdHigh = pd.pdHigh;
  const pdLow = pd.pdLow;

  console.log(`[AI] P/D 计算 (${pd.source}): P=${pdHigh.toFixed(0)} D=${pdLow.toFixed(0)}`);

  // 清算数据
  let liquidationInfo = '';
  if (liq) {
    const keyLevels = extractKeyLiquidationLevels(liq, mtf.currentPrice, 3);
    liquidationInfo = `清算: 多头${keyLevels.longLiquidation.slice(0,2).map(l => `$${l.price.toFixed(0)}`).join(',') || '无'} | 空头${keyLevels.shortLiquidation.slice(0,2).map(l => `$${l.price.toFixed(0)}`).join(',') || '无'}`;
  }

  const prompt = `BTC 交易分析。分析趋势和最佳下单区间。

## 当前状态
价格: $${mtf.currentPrice.toFixed(2)}
P (溢价区): $${pdHigh.toFixed(0)} | D (折扣区): $${pdLow.toFixed(0)}
偏离D: ${((mtf.currentPrice - pdLow) / pdLow * 100).toFixed(1)}%

## HTF 趋势
4D=${mtf.htf.fourDay.trend} | 1D=${mtf.htf.daily.trend} | 4H=${mtf.htf.h4.trend}
对齐度: ${mtf.alignment}%

## 清算水平
${liquidationInfo}

## 附近 ICT 块 (4H)
${formatICTLevels(mtf.ict.h4, mtf.currentPrice)}

## 4H K线
${formatKlines(mtf.klines.fd?.slice(-10) || [], '4H')}

## 分析任务
1. 给出趋势判断（看多/看空/震荡）
2. 如果看多，找出适合做多的价格区间（应该在 D 位以下入场）
3. 如果看空，找出适合做空的价格区间（应该在 P 位以上入场）
4. 每个区间给出：入场区间、止损、止盈、RR
5. 说明使用了哪个 ICT 块作为确认

## 守塔规则
- 多单止损 = 入场价 × 0.003（约 0.3%）
- 空单止损 = 入场价 × 1.003（约 0.3%）
- 多单止盈 = 入场价 × 1.05（+5%）
- 空单止盈 = 入场价 × 0.95（-5%）
- RR >= ${adjustedRR}

## 输出格式
输出 1-2 个最佳下单区间：
{"recommendations":[{"direction":"long","entryZone":"$68000-$69000","stopLoss":"$67800","takeProfit":"$71500","rr":15,"reason":"回踩D位企稳","ictConfirm":"bullish OB at $68500"},{"direction":"short","entryZone":"$74000-$74500","stopLoss":"$74300","takeProfit":"$70500","rr":12,"reason":"P位附近反弹","ictConfirm":"bearish FVG at $74200"}],"summary":"趋势描述"}

只输出 JSON，不要其他文字。`;

  return prompt;
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
    // 获取 1D K 线用于 P/D 计算
    const dailyKlines = await fetchKlines(mtfAnalysis.symbol, '1d', 200);

    const client = getAIClient();
    const prompt = buildMTFPrompt(mtfAnalysis, dailyKlines, liquidationData);

    console.log(`[AI] 使用 ${client.getName()} 执行 MTF 分析 ${mtfAnalysis.symbol}...`);

    const responseText = await client.generateContent(prompt);
    return parseAIResponse(responseText);
  } catch (error) {
    console.error('[AI] MTF 分析调用失败:', error);
    return null;
  }
}

// ============================================
// 反转交易信号
// ============================================

/**
 * 构建反转信号 Prompt
 */
function buildReversalPrompt(mtf: MTFAnalysis, liq: LiquidationData | null): string {
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

  // 添加极值信息
  const extremeInfo = `
## 近期极值（最近 200 根 15m K 线）
- 最高价: $${mtf.recentExtreme.high.toFixed(2)}
- 最低价: $${mtf.recentExtreme.low.toFixed(2)}
- 当前价: $${mtf.currentPrice.toFixed(2)}

**反转入场规则**:
- 开空信号: 入场点必须在 $${mtf.recentExtreme.high.toFixed(2)} 上方（突破后寻找空头入场）
- 开多信号: 入场点必须在 $${mtf.recentExtreme.low.toFixed(2)} 下方（跌破后寻找多头入场）
`;

  // 格式化入场设置信息
  let entryInfo = '无有效入场点';
  if (mtf.reversal.entry) {
    const e = mtf.reversal.entry;
    entryInfo = `
- 类型: ${e.type.toUpperCase()}
- 方向: ${e.bias}
- 入场区间: $${e.entryZone.low.toFixed(2)} - $${e.entryZone.high.toFixed(2)}
- 建议入场: $${e.suggestedEntry.toFixed(2)}
- 止损: $${e.stopLoss.toFixed(2)}
- 止盈目标: ${e.takeProfits.map(tp => `$${tp.toFixed(2)}`).join(', ')}
- 预期盈亏比: ${e.riskReward}`;
  }

  return `你是一位 ICT 交易分析师，专门寻找高风险回报比（RR >= ${getAdjustedRRThreshold(15, 7)}）的反转交易机会。

⚠️ **重要：反转交易风险极高，RR 必须更高才能补偿风险**

## 反转背景
- HTF 方向: ${mtf.htf.bias}（日线/4H）
- LTF 方向: ${mtf.reversal.ltfBias}（5m/15m/1h）
- LTF 对齐度: ${mtf.reversal.ltfAlignment}%
- HTF 与 LTF 方向相反，存在反转可能性

## 近期极值
- 最高: $${mtf.recentExtreme.high.toFixed(2)}
- 最低: $${mtf.recentExtreme.low.toFixed(2)}
- 当前: $${mtf.currentPrice.toFixed(2)}

反转入场规则：
- 做空: 必须突破 ${mtf.recentExtreme.high.toFixed(2)} 后回落
- 做多: 必须跌破 ${mtf.recentExtreme.low.toFixed(2)} 后反弹

## Step 1: LTF 入场点评估

${entryInfo}

## Step 2: 计算 RR

**止损规则（严格）**：
- 多单止损 = 入场价 × 0.997（千分之3）
- 空单止损 = 入场价 × 1.003（千分之3）

**止盈目标**：
- 清算密集区作为目标
${liquidationInfo}

## Step 3: K线形态确认

${formatKlines(mtf.klines.fd, '4D')}

${formatKlines(mtf.klines.m15, '15M')}

${formatKlines(mtf.klines.m5, '5M')}

## 输出要求

{
  "direction": "long" | "short" | "neutral",
  "confidence": "high" | "medium" | "low",
  "entry": { "price": 数字, "zone": "说明" },
  "stopLoss": { "price": 数字, "reason": "原因" },
  "takeProfit": [{ "price": 数字, "reason": "原因" }],
  "riskReward": 数字,
  "reasoning": "分析理由",
  "warnings": ["风险提示"]
}

**重要规则**：
1. 方向必须与 LTF 方向一致
2. 反转交易置信度最高只能是 "medium"
3. **RR 必须 >= ${getAdjustedRRThreshold(15, 7)}**，否则返回 neutral
4. 止损紧贴结构位（千分之3以内）
5. 必须有 OTE 或 FVG 确认`;

}

/**
 * 生成反转交易信号
 */
export async function generateReversalSignal(
  mtfAnalysis: MTFAnalysis,
  liquidationData: LiquidationData | null
): Promise<TradeSignal | null> {
  const check = canCallAI();
  if (!check.allowed) {
    console.log(`[AI] 跳过反转分析: ${check.reason}`);
    return null;
  }

  // 必须有反转入场点
  if (!mtfAnalysis.reversal.entry) {
    console.log(`[AI] 无反转入场点，跳过`);
    return null;
  }

  hourlyCallCount++;
  dailyCallCount++;

  try {
    const client = getAIClient();
    const prompt = buildReversalPrompt(mtfAnalysis, liquidationData);

    console.log(`[AI] 使用 ${client.getName()} 分析反转机会 ${mtfAnalysis.symbol}...`);

    const responseText = await client.generateContent(prompt);
    const signal = parseAIResponse(responseText);

    // 反转信号强制限制置信度
    if (signal && signal.confidence === 'high') {
      signal.confidence = 'medium';
    }

    // 确保有反转警告
    if (signal && signal.direction !== 'neutral') {
      const reversalWarnings = [
        '逆势交易，风险较高',
        `HTF 趋势仍为 ${mtfAnalysis.htf.bias}`,
      ];
      signal.warnings = [...reversalWarnings, ...signal.warnings];
    }

    return signal;
  } catch (error) {
    console.error('[AI] 反转分析调用失败:', error);
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
