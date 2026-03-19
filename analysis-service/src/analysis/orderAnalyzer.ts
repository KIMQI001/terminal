/**
 * 订单分析模块
 * 分析守塔策略当前挂单，给出调整建议
 */

import { getRecentPerformance, getAdjustedRRThreshold } from '../signals/signalStore';
import { OpenOrder } from '../order/exchangeAdapter';

/**
 * 订单分析结果
 */
export interface OrderAnalysis {
  symbol: string;
  hasOrders: boolean;
  orders: Array<{
    side: 'buy' | 'sell';
    positionSide: 'long' | 'short' | 'both';
    price: number;
    quantity: number;
    type: string;
  }>;
  marketAnalysis: {
    htfDirection: string;
    alignment: number;
    entryType: string | null;
    currentPrice: number;
  };
  recommendation: {
    action: '正常' | '调整' | '取消' | '观望';
    reason: string;
    ordersToCancel?: number[];
    ordersToModify?: Array<{ orderId: number; newPrice: number }>;
  } | null;
}

/**
 * 构建订单分析 Prompt
 */
export function buildOrderAnalysisPrompt(
  orders: OpenOrder[],
  currentPrice: number,
  symbol: string,
  htfBias: string,
  alignment: number,
  entryType: string | null
): string {
  const adjustedRR = getAdjustedRRThreshold(15, 7);
  const perf = getRecentPerformance(7);

  const orderList = orders.map(o => {
    const side = o.side === 'BUY' ? '多' : '空';
    const posSide = o.positionSide === 'LONG' ? '多' : o.positionSide === 'SHORT' ? '空' : '双向';
    return `${side} ${posSide}: $${o.price}, ${o.origQty}张, ${o.type}`;
  }).join('\n');

  return `${symbol} 订单分析

当前价格: $${currentPrice.toFixed(2)}

挂单:
${orderList}

市场:
- HTF: ${htfBias}, 对齐${alignment}%
- 入场: ${entryType || '无'}

${perf.total > 0 ? `近期: ${perf.total}信号, 胜${perf.winRate.toFixed(0)}%, RR阈值${adjustedRR}` : ''}

建议(JSON):
{
  "action": "正常|调整|取消|观望",
  "reason": "原因"
}`;
}

/**
 * 简单规则分析
 */
export function analyzeOrdersByRules(
  orders: OpenOrder[],
  currentPrice: number,
  symbol: string,
  htfBias: string,
  alignment: number,
  entryType: string | null
): OrderAnalysis {
  if (orders.length === 0) {
    return {
      symbol,
      hasOrders: false,
      orders: [],
      marketAnalysis: { htfDirection: htfBias, alignment, entryType, currentPrice },
      recommendation: null,
    };
  }

  // 统计多空单
  const longOrders = orders.filter(o => o.positionSide === 'LONG' || o.positionSide === 'BOTH');
  const shortOrders = orders.filter(o => o.positionSide === 'SHORT' || o.positionSide === 'BOTH');

  let action: '正常' | '调整' | '取消' | '观望' = '正常';
  let reason = `多单${longOrders.length}个, 空单${shortOrders.length}个`;

  // 如果 HTF 方向与订单方向不符，建议调整
  if (htfBias === 'bullish' && shortOrders.length > longOrders.length) {
    action = '调整';
    reason = '空单过多，与HTF方向不符';
  } else if (htfBias === 'bearish' && longOrders.length > shortOrders.length) {
    action = '调整';
    reason = '多单过多，与HTF方向不符';
  }

  return {
    symbol,
    hasOrders: true,
    orders: orders.map(o => ({
      side: o.side === 'BUY' ? 'buy' : 'sell',
      positionSide: o.positionSide === 'LONG' ? 'long' : o.positionSide === 'SHORT' ? 'short' : 'both',
      price: o.price,
      quantity: parseFloat(o.origQty),
      type: o.type,
    })),
    marketAnalysis: { htfDirection: htfBias, alignment, entryType, currentPrice },
    recommendation: { action, reason },
  };
}
