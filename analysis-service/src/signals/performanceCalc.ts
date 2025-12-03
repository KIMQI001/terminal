/**
 * 绩效计算模块
 * 计算胜率、盈亏比、期望值等指标
 */

import { SignalRecord } from '../db';
import { getSignalsByDateRange, getCompletedSignals } from './signalStore';

/**
 * 绩效统计接口
 */
export interface PerformanceStats {
  // 基础统计
  totalSignals: number;       // 总信号数
  enteredSignals: number;     // 入场信号数
  completedSignals: number;   // 完成的信号数（止盈+止损）
  pendingSignals: number;     // 待入场信号数
  expiredSignals: number;     // 过期信号数

  // 盈亏统计
  winCount: number;           // 盈利次数
  lossCount: number;          // 亏损次数
  winRate: number;            // 胜率 (0-1)

  // 盈亏比统计
  avgWinRR: number;           // 平均盈利 RR
  avgLossRR: number;          // 平均亏损 RR（通常为 1）
  avgRR: number;              // 平均实际盈亏比
  profitFactor: number;       // 盈利因子 (总盈/总亏)
  expectancy: number;         // 期望值 (R)

  // 盈亏金额（百分比）
  totalPnlPercent: number;    // 总盈亏百分比
  avgWinPercent: number;      // 平均盈利百分比
  avgLossPercent: number;     // 平均亏损百分比

  // 维度统计
  byTimeframe: Record<string, TimeframeStats>;
  byDirection: Record<string, DirectionStats>;
}

export interface TimeframeStats {
  signals: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgRR: number;
}

export interface DirectionStats {
  signals: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgRR: number;
}

/**
 * 计算信号集合的绩效统计
 */
export function calculatePerformance(signals: SignalRecord[]): PerformanceStats {
  const completed = signals.filter(s => s.status === 'stopped' || s.status === 'profit');
  const wins = completed.filter(s => s.status === 'profit');
  const losses = completed.filter(s => s.status === 'stopped');
  const pending = signals.filter(s => s.status === 'pending');
  const entered = signals.filter(s => s.status === 'entered');
  const expired = signals.filter(s => s.status === 'expired');

  // 基础统计
  const totalSignals = signals.length;
  const completedSignals = completed.length;
  const winCount = wins.length;
  const lossCount = losses.length;
  const winRate = completedSignals > 0 ? winCount / completedSignals : 0;

  // 盈亏比计算
  const winRRs = wins.map(s => s.actualRR ?? 0).filter(rr => rr > 0);
  const lossRRs = losses.map(s => Math.abs(s.actualRR ?? 1));

  const avgWinRR = winRRs.length > 0
    ? winRRs.reduce((a, b) => a + b, 0) / winRRs.length
    : 0;
  const avgLossRR = lossRRs.length > 0
    ? lossRRs.reduce((a, b) => a + b, 0) / lossRRs.length
    : 1;

  const allRRs = completed.map(s => s.actualRR ?? 0);
  const avgRR = allRRs.length > 0
    ? allRRs.reduce((a, b) => a + b, 0) / allRRs.length
    : 0;

  // 盈利因子：总盈利 / 总亏损
  const totalWinRR = winRRs.reduce((a, b) => a + b, 0);
  const totalLossRR = lossRRs.reduce((a, b) => a + b, 0);
  const profitFactor = totalLossRR > 0 ? totalWinRR / totalLossRR : totalWinRR > 0 ? Infinity : 0;

  // 期望值：(胜率 * 平均盈利) - ((1-胜率) * 平均亏损)
  const expectancy = (winRate * avgWinRR) - ((1 - winRate) * avgLossRR);

  // 盈亏百分比统计
  const winPercents = wins.map(s => s.pnlPercent ?? 0);
  const lossPercents = losses.map(s => Math.abs(s.pnlPercent ?? 0));
  const allPnls = completed.map(s => s.pnlPercent ?? 0);

  const totalPnlPercent = allPnls.reduce((a, b) => a + b, 0);
  const avgWinPercent = winPercents.length > 0
    ? winPercents.reduce((a, b) => a + b, 0) / winPercents.length
    : 0;
  const avgLossPercent = lossPercents.length > 0
    ? lossPercents.reduce((a, b) => a + b, 0) / lossPercents.length
    : 0;

  // 按周期统计
  const byTimeframe = calculateByDimension(completed, 'timeframe');

  // 按方向统计
  const byDirection = calculateByDimension(completed, 'direction');

  return {
    totalSignals,
    enteredSignals: entered.length,
    completedSignals,
    pendingSignals: pending.length,
    expiredSignals: expired.length,
    winCount,
    lossCount,
    winRate,
    avgWinRR,
    avgLossRR,
    avgRR,
    profitFactor,
    expectancy,
    totalPnlPercent,
    avgWinPercent,
    avgLossPercent,
    byTimeframe,
    byDirection,
  };
}

/**
 * 按维度计算统计
 */
function calculateByDimension(
  signals: SignalRecord[],
  dimension: 'timeframe' | 'direction'
): Record<string, TimeframeStats> {
  const groups: Record<string, SignalRecord[]> = {};

  for (const signal of signals) {
    const key = signal[dimension];
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(signal);
  }

  const result: Record<string, TimeframeStats> = {};

  for (const [key, group] of Object.entries(groups)) {
    const wins = group.filter(s => s.status === 'profit');
    const losses = group.filter(s => s.status === 'stopped');
    const winRate = group.length > 0 ? wins.length / group.length : 0;

    const rrs = group.map(s => s.actualRR ?? 0);
    const avgRR = rrs.length > 0 ? rrs.reduce((a, b) => a + b, 0) / rrs.length : 0;

    result[key] = {
      signals: group.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate,
      avgRR,
    };
  }

  return result;
}

/**
 * 获取昨天的日期范围
 */
export function getYesterdayRange(): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * 获取今天的日期范围
 */
export function getTodayRange(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * 获取过去N天的日期范围
 */
export function getLastNDaysRange(days: number): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * 获取本周的日期范围（周一开始）
 */
export function getThisWeekRange(): { start: Date; end: Date } {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // 调整周一为第一天

  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  return { start, end };
}

/**
 * 获取每日绩效统计
 */
export function getDailyStats(date?: Date): PerformanceStats {
  const { start, end } = date
    ? { start: date, end: new Date(date.getTime() + 24 * 60 * 60 * 1000) }
    : getYesterdayRange();

  const signals = getSignalsByDateRange(start, end);
  return calculatePerformance(signals);
}

/**
 * 获取每周绩效统计
 */
export function getWeeklyStats(): PerformanceStats {
  const { start, end } = getThisWeekRange();
  const signals = getSignalsByDateRange(start, end);
  return calculatePerformance(signals);
}

/**
 * 获取过去N天的绩效统计
 */
export function getLastNDaysStats(days: number): PerformanceStats {
  const { start, end } = getLastNDaysRange(days);
  const signals = getSignalsByDateRange(start, end);
  return calculatePerformance(signals);
}

/**
 * 获取所有已完成信号的绩效统计
 */
export function getAllTimeStats(): PerformanceStats {
  const signals = getCompletedSignals();
  return calculatePerformance(signals);
}

/**
 * 格式化绩效统计为可读字符串
 */
export function formatPerformanceStats(stats: PerformanceStats): string {
  const lines = [
    `📊 绩效统计`,
    ``,
    `**基础统计**`,
    `- 总信号: ${stats.totalSignals}`,
    `- 已完成: ${stats.completedSignals} (胜: ${stats.winCount}, 负: ${stats.lossCount})`,
    `- 待入场: ${stats.pendingSignals}`,
    `- 已过期: ${stats.expiredSignals}`,
    ``,
    `**盈亏指标**`,
    `- 胜率: ${(stats.winRate * 100).toFixed(1)}%`,
    `- 平均盈亏比: ${stats.avgRR.toFixed(2)}`,
    `- 盈利因子: ${stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}`,
    `- 期望值: ${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(2)}R`,
    ``,
    `**累计盈亏**`,
    `- 总盈亏: ${stats.totalPnlPercent >= 0 ? '+' : ''}${stats.totalPnlPercent.toFixed(2)}%`,
    `- 平均盈利: +${stats.avgWinPercent.toFixed(2)}%`,
    `- 平均亏损: -${stats.avgLossPercent.toFixed(2)}%`,
  ];

  // 添加周期统计
  if (Object.keys(stats.byTimeframe).length > 0) {
    lines.push('', '**按周期**');
    for (const [tf, s] of Object.entries(stats.byTimeframe)) {
      lines.push(
        `- ${tf}: ${s.signals} 个, 胜率 ${(s.winRate * 100).toFixed(0)}%, RR ${s.avgRR.toFixed(2)}`
      );
    }
  }

  // 添加方向统计
  if (Object.keys(stats.byDirection).length > 0) {
    lines.push('', '**按方向**');
    for (const [dir, s] of Object.entries(stats.byDirection)) {
      const label = dir === 'long' ? '做多 📈' : '做空 📉';
      lines.push(
        `- ${label}: ${s.signals} 个, 胜率 ${(s.winRate * 100).toFixed(0)}%`
      );
    }
  }

  return lines.join('\n');
}
