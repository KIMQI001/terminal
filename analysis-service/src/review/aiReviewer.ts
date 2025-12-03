/**
 * AI 复盘分析模块
 * 让 AI 分析自己的交易表现并提出改进建议
 */

import { PerformanceStats, formatPerformanceStats } from '../signals/performanceCalc';
import { canCallAI, getProviderInfo } from '../analysis/aiAnalyzer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config';

/**
 * AI 客户端接口（复用 aiAnalyzer 的设计）
 */
interface AIClient {
  generateContent(prompt: string): Promise<string>;
}

/**
 * 创建 AI 客户端
 */
function createReviewClient(): AIClient {
  switch (config.ai.provider) {
    case 'gemini': {
      const client = new GoogleGenerativeAI(config.ai.apiKey);
      const model = config.ai.model || config.ai.defaultModels.gemini;
      return {
        async generateContent(prompt: string): Promise<string> {
          const genModel = client.getGenerativeModel({ model });
          const result = await genModel.generateContent(prompt);
          return result.response.text();
        },
      };
    }
    case 'claude': {
      const client = new Anthropic({ apiKey: config.ai.apiKey });
      const model = config.ai.model || config.ai.defaultModels.claude;
      return {
        async generateContent(prompt: string): Promise<string> {
          const response = await client.messages.create({
            model,
            max_tokens: 800,
            messages: [{ role: 'user', content: prompt }],
          });
          const content = response.content[0];
          if (content.type !== 'text') throw new Error('Claude 响应格式错误');
          return content.text;
        },
      };
    }
    case 'openai':
    case 'deepseek': {
      const baseURL = config.ai.provider === 'deepseek'
        ? 'https://api.deepseek.com/v1'
        : undefined;
      const client = new OpenAI({ apiKey: config.ai.apiKey, baseURL });
      const model = config.ai.model || config.ai.defaultModels[config.ai.provider];
      return {
        async generateContent(prompt: string): Promise<string> {
          const response = await client.chat.completions.create({
            model,
            max_tokens: 800,
            messages: [{ role: 'user', content: prompt }],
          });
          return response.choices[0]?.message?.content || '';
        },
      };
    }
    default:
      throw new Error(`不支持的 AI 提供商: ${config.ai.provider}`);
  }
}

/**
 * 构建每日复盘 Prompt
 */
function buildDailyReviewPrompt(stats: PerformanceStats): string {
  const statsText = formatPerformanceStats(stats);

  return `你是一位专业的交易复盘分析师。请根据以下每日交易统计数据进行简短分析。

${statsText}

请用简洁的中文回答（150字以内）：
1. 今日整体表现如何？（好/一般/差）
2. 有什么值得注意的亮点或问题？
3. 明天需要注意什么？

注意：如果信号数量为0，说"今日无交易信号"即可。`;
}

/**
 * 构建每周复盘 Prompt
 */
function buildWeeklyReviewPrompt(stats: PerformanceStats): string {
  const statsText = formatPerformanceStats(stats);

  return `你是一位专业的交易复盘分析师。请根据以下每周交易统计数据进行深度分析。

${statsText}

请用简洁的中文回答（200字以内）：
1. 本周整体表现评价
2. 哪些周期/方向表现最好？为什么？
3. 主要问题和改进建议
4. 下周策略建议

注意：如果数据不足，请说明需要更多数据来得出结论。`;
}

/**
 * 生成每日 AI 复盘分析
 */
export async function generateDailyReview(stats: PerformanceStats): Promise<string | null> {
  // 检查是否可以调用 AI
  const check = canCallAI();
  if (!check.allowed) {
    console.log(`[AIReview] 跳过复盘: ${check.reason}`);
    return null;
  }

  // 如果没有信号，返回简单消息
  if (stats.totalSignals === 0) {
    return '📊 **每日复盘**\n\n今日无交易信号生成。';
  }

  try {
    console.log(`[AIReview] 使用 ${getProviderInfo()} 生成每日复盘...`);
    const client = createReviewClient();
    const prompt = buildDailyReviewPrompt(stats);
    const response = await client.generateContent(prompt);

    return `📊 **AI 每日复盘**\n\n${response}`;
  } catch (error) {
    console.error('[AIReview] 生成每日复盘失败:', error);
    return null;
  }
}

/**
 * 生成每周 AI 复盘分析
 */
export async function generateWeeklyReview(stats: PerformanceStats): Promise<string | null> {
  // 检查是否可以调用 AI
  const check = canCallAI();
  if (!check.allowed) {
    console.log(`[AIReview] 跳过复盘: ${check.reason}`);
    return null;
  }

  // 如果信号太少，返回简单消息
  if (stats.completedSignals < 3) {
    return '📊 **每周复盘**\n\n本周完成的信号数量不足（少于3个），暂无法进行有效分析。';
  }

  try {
    console.log(`[AIReview] 使用 ${getProviderInfo()} 生成每周复盘...`);
    const client = createReviewClient();
    const prompt = buildWeeklyReviewPrompt(stats);
    const response = await client.generateContent(prompt);

    return `📊 **AI 每周复盘**\n\n${response}`;
  } catch (error) {
    console.error('[AIReview] 生成每周复盘失败:', error);
    return null;
  }
}

/**
 * 生成自定义时段的 AI 复盘分析
 */
export async function generateCustomReview(
  stats: PerformanceStats,
  periodName: string
): Promise<string | null> {
  const check = canCallAI();
  if (!check.allowed) {
    console.log(`[AIReview] 跳过复盘: ${check.reason}`);
    return null;
  }

  if (stats.completedSignals === 0) {
    return `📊 **${periodName}复盘**\n\n该时段无已完成的交易信号。`;
  }

  try {
    console.log(`[AIReview] 使用 ${getProviderInfo()} 生成${periodName}复盘...`);
    const client = createReviewClient();

    const statsText = formatPerformanceStats(stats);
    const prompt = `你是一位专业的交易复盘分析师。请根据以下${periodName}交易统计数据进行分析。

${statsText}

请用简洁的中文回答（150字以内）：
1. 整体表现评价
2. 主要问题
3. 改进建议`;

    const response = await client.generateContent(prompt);
    return `📊 **AI ${periodName}复盘**\n\n${response}`;
  } catch (error) {
    console.error(`[AIReview] 生成${periodName}复盘失败:`, error);
    return null;
  }
}
