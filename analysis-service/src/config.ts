/**
 * 分析服务配置
 */
export const config = {
  // 数据源
  klineServer: {
    restUrl: process.env.KLINE_API_URL || 'http://127.0.0.1:3001',
  },

  // 清算数据服务 (liquidation-service)
  liqService: {
    url: process.env.LIQ_SERVICE_URL || 'http://127.0.0.1:3004',
  },

  // 监控的交易对
  watchlist: [
    { symbol: 'BTCUSDC' },
  ],

  // 分析模式配置
  analysis: {
    // 'single' = 独立周期分析, 'mtf' = 多时间框架综合分析
    mode: (process.env.ANALYSIS_MODE || 'mtf') as 'single' | 'mtf',

    // MTF 模式配置
    mtf: {
      htf: ['1d', '4h'] as const,   // 高时间框架 - 确定方向
      mtf: ['1h'] as const,          // 中时间框架 - 确认结构
      ltf: ['15m', '5m'] as const,   // 低时间框架 - 寻找入场
      minAlignment: 50,              // 最小对齐度要求 (0-100)
    },

    // 单周期模式的时间框架 (仅 mode='single' 时使用)
    singleTimeframes: ['5m', '15m', '1h', '4h', '1d', '1w'] as const,
  },

  // AI 配置
  ai: {
    enabled: process.env.AI_ANALYSIS_ENABLED !== 'false',  // 默认开启，设 false 关闭
    provider: (process.env.AI_PROVIDER || 'gemini') as 'gemini' | 'claude' | 'openai' | 'deepseek' | 'minimax',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '', // 留空则使用默认模型
    maxTokens: 4000, // thinking 模型需要更多 tokens
    // 成本控制 (MTF 模式每次分析只调用 1 次 AI，成本大幅降低)
    maxCallsPerHour: 10,
    maxCallsPerDay: 200,
    // 各提供商默认模型
    defaultModels: {
      gemini: 'gemini-1.5-flash',
      claude: 'claude-3-sonnet-20240229',
      openai: 'gpt-4o-mini',
      deepseek: 'deepseek-chat',
      minimax: 'MiniMax-M2.7',  // MiniMax Token Plan 默认模型
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

  // 守塔策略配置
  tower: {
    // 订单距离过滤：价格远离 P/D 超过此比例时不下单 (默认 1%)
    orderDistanceFilter: process.env.TOWER_ORDER_DISTANCE_FILTER === 'true',
    orderDistanceThreshold: 0.01,  // 1%
  },

  // 日志
  debug: process.env.DEBUG === 'true',
};

/**
 * 验证配置
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (config.ai.enabled && !config.ai.apiKey) {
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
