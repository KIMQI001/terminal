/**
 * 分析服务配置
 */
export const config = {
  // 数据源
  klineServer: {
    restUrl: process.env.KLINE_API_URL || 'http://127.0.0.1:3001',
  },

  // 监控的交易对和周期
  watchlist: [
    { symbol: 'BTCUSDC', timeframes: ['15m', '1h', '4h'] as const },
  ],

  // AI 配置
  ai: {
    provider: (process.env.AI_PROVIDER || 'gemini') as 'gemini' | 'claude' | 'openai' | 'deepseek',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '', // 留空则使用默认模型
    maxTokens: 1500,
    // 成本控制
    maxCallsPerHour: 20,
    maxCallsPerDay: 300,
    // 各提供商默认模型
    defaultModels: {
      gemini: 'gemini-1.5-flash',
      claude: 'claude-3-sonnet-20240229',
      openai: 'gpt-4o-mini',
      deepseek: 'deepseek-chat',
    } as Record<string, string>,
  },

  // 钉钉配置
  dingtalk: {
    webhook: process.env.DINGTALK_WEBHOOK || '',
    secret: process.env.DINGTALK_SECRET || '',
  },

  // 调度配置
  schedule: {
    // 每 15 分钟执行一次
    interval: process.env.SCHEDULE_INTERVAL || '*/15 * * * *',
    // 触发模式: scheduled (定时) | signal (信号触发)
    triggerMode: (process.env.TRIGGER_MODE || 'scheduled') as 'scheduled' | 'signal',
  },

  // 日志
  debug: process.env.DEBUG === 'true',
};

/**
 * 验证配置
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.ai.apiKey) {
    errors.push('AI_API_KEY 未配置');
  }

  if (!config.dingtalk.webhook) {
    errors.push('DINGTALK_WEBHOOK 未配置');
  }

  if (!config.dingtalk.secret) {
    errors.push('DINGTALK_SECRET 未配置');
  }

  if (errors.length > 0) {
    console.error('配置错误:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }
}
