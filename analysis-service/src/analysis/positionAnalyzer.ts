/**
 * 持仓分析模块
 * 分析守塔策略当前持仓，给出持有/加仓/减仓/止损建议
 */

import { getRecentPerformance, getAdjustedRRThreshold } from '../signals/signalStore';
import { Position } from '../order/exchangeAdapter';

/**
 * 持仓分析结果
 */
export interface PositionAnalysis {
  symbol: string;
  hasPosition: boolean;
  positions: Array<{
    side: 'long' | 'short';
    amount: number;
    entryPrice: number;
    currentPrice: number;
    pnl: number;
    pnlPercent: number;
    leverage: number;
  }>;
  marketAnalysis: {
    htfDirection: string;
    alignment: number;
    entryType: string | null;
  };
  recommendation: {
    action: '持有' | '加仓' | '减仓' | '止损' | '观望';
    reason: string;
    targetPrice: number | null;
    stopPrice: number | null;
  } | null;
}

/**
 * 构建持仓分析 Prompt
 */
export function buildPositionAnalysisPrompt(
  positions: Position[],
  currentPrice: number,
  symbol: string,
  htfBias: string,
  alignment: number,
  entryType: string | null
): string {
  const adjustedRR = getAdjustedRRThreshold(15, 7);
  const perf = getRecentPerformance(7);

  const posList = positions.map(p => {
    const pnl = p.positionAmt * (currentPrice - p.entryPrice);
    const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice * 100).toFixed(2);
    const side = p.positionSide === 'LONG' ? '多' : '空';
    return `${side}: ${p.positionAmt}张, 入场$${p.entryPrice}, 当前$${currentPrice}, PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}(${pnlPct}%), ${p.leverage}x`;
  }).join('\n');

  return `${symbol} 持仓分析

持仓:
${posList}

市场:
- HTF: ${htfBias}, 对齐${alignment}%
- 入场: ${entryType || '无'}
- 现价: $${currentPrice.toFixed(2)}

${perf.total > 0 ? `近期: ${perf.total}信号, 胜${perf.winRate.toFixed(0)}%, RR阈值${adjustedRR}` : ''}

建议(JSON):
{
  "action": "持有|加仓|减仓|止损|观望",
  "reason": "原因",
  "targetPrice": 数字|null,
  "stopPrice": 数字|null
}`;
}

/**
 * 简单规则分析
 */
export function analyzePositionsByRules(
  positions: Position[],
  currentPrice: number,
  symbol: string,
  htfBias: string,
  alignment: number,
  entryType: string | null
): PositionAnalysis {
  if (positions.length === 0) {
    return {
      symbol,
      hasPosition: false,
      positions: [],
      marketAnalysis: { htfDirection: htfBias, alignment, entryType },
      recommendation: null,
    };
  }

  const pos = positions[0];
  const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
  const side = pos.positionSide === 'LONG' ? '多' : '空';

  // 简单规则判断
  let action: '持有' | '加仓' | '减仓' | '止损' | '观望' = '持有';
  let reason = `${side}仓浮盈${pnlPct.toFixed(2)}%`;

  if (pnlPct < -0.5) {
    action = '止损';
    reason = `${side}仓亏损${pnlPct.toFixed(2)}%`;
  } else if (pnlPct > 3) {
    action = '减仓';
    reason = `${side}仓盈利${pnlPct.toFixed(2)}%, 建议部分止盈`;
  }

  return {
    symbol,
    hasPosition: true,
    positions: positions.map(p => {
      const pnl = p.positionAmt * (currentPrice - p.entryPrice);
      const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice * 100);
      return {
        side: p.positionSide === 'LONG' ? 'long' : 'short',
        amount: p.positionAmt,
        entryPrice: p.entryPrice,
        currentPrice,
        pnl,
        pnlPercent: pnlPct,
        leverage: p.leverage,
      };
    }),
    marketAnalysis: { htfDirection: htfBias, alignment, entryType },
    recommendation: {
      action,
      reason,
      targetPrice: null,
      stopPrice: null,
    },
  };
}
