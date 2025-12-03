/**
 * 复盘调度器
 * 每日自动生成绩效报告和 AI 复盘分析
 */

import cron from 'node-cron';
import {
  getDailyStats,
  getWeeklyStats,
  formatPerformanceStats,
  getYesterdayRange,
} from '../signals/performanceCalc';
import { generateDailyReview, generateWeeklyReview } from './aiReviewer';
import { sendDingtalkMarkdown } from '../notification/dingtalk';
import { getSignalStats } from '../signals/signalStore';

/**
 * 格式化每日统计报告消息
 */
function formatDailyReportMessage(): string {
  const { start, end } = getYesterdayRange();
  const stats = getDailyStats(start);
  const signalStats = getSignalStats(start, end);

  const dateStr = start.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const lines = [
    `## 📅 ${dateStr} 每日报告`,
    '',
    '### 信号概览',
    `- 总信号: ${signalStats.total}`,
    `- 待入场: ${signalStats.pending}`,
    `- 已入场: ${signalStats.entered}`,
    `- 止盈: ${signalStats.profit}`,
    `- 止损: ${signalStats.stopped}`,
    `- 过期: ${signalStats.expired}`,
  ];

  if (stats.completedSignals > 0) {
    lines.push(
      '',
      '### 绩效统计',
      `- 胜率: ${(stats.winRate * 100).toFixed(1)}%`,
      `- 盈亏比: ${stats.avgRR.toFixed(2)}`,
      `- 期望值: ${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(2)}R`,
      `- 总盈亏: ${stats.totalPnlPercent >= 0 ? '+' : ''}${stats.totalPnlPercent.toFixed(2)}%`
    );
  }

  return lines.join('\n');
}

/**
 * 格式化每周统计报告消息
 */
function formatWeeklyReportMessage(): string {
  const stats = getWeeklyStats();

  const lines = [
    `## 📊 本周绩效报告`,
    '',
    formatPerformanceStats(stats),
  ];

  return lines.join('\n');
}

/**
 * 执行每日复盘
 */
async function runDailyReview(): Promise<void> {
  console.log('[ReviewScheduler] 开始每日复盘...');

  try {
    // 1. 发送每日统计报告
    const reportMsg = formatDailyReportMessage();
    await sendDingtalkMarkdown('每日报告', reportMsg);

    // 2. 生成 AI 复盘分析
    const { start } = getYesterdayRange();
    const stats = getDailyStats(start);
    const aiReview = await generateDailyReview(stats);

    if (aiReview) {
      await sendDingtalkMarkdown('AI 复盘', aiReview);
    }

    console.log('[ReviewScheduler] 每日复盘完成');
  } catch (error) {
    console.error('[ReviewScheduler] 每日复盘失败:', error);
  }
}

/**
 * 执行每周复盘
 */
async function runWeeklyReview(): Promise<void> {
  console.log('[ReviewScheduler] 开始每周复盘...');

  try {
    // 1. 发送每周统计报告
    const reportMsg = formatWeeklyReportMessage();
    await sendDingtalkMarkdown('每周报告', reportMsg);

    // 2. 生成 AI 复盘分析
    const stats = getWeeklyStats();
    const aiReview = await generateWeeklyReview(stats);

    if (aiReview) {
      await sendDingtalkMarkdown('AI 周复盘', aiReview);
    }

    console.log('[ReviewScheduler] 每周复盘完成');
  } catch (error) {
    console.error('[ReviewScheduler] 每周复盘失败:', error);
  }
}

/**
 * 启动复盘调度器
 */
export function startReviewScheduler(): void {
  console.log('[ReviewScheduler] 启动复盘调度器');

  // 每日复盘 - 每天 00:05 执行（北京时间）
  // 给一些缓冲时间确保前一天的数据完整
  cron.schedule('5 0 * * *', async () => {
    await runDailyReview();
  }, {
    timezone: 'Asia/Shanghai',
  });

  console.log('[ReviewScheduler] 每日复盘已调度: 每天 00:05 (北京时间)');

  // 每周复盘 - 每周一 00:10 执行（北京时间）
  cron.schedule('10 0 * * 1', async () => {
    await runWeeklyReview();
  }, {
    timezone: 'Asia/Shanghai',
  });

  console.log('[ReviewScheduler] 每周复盘已调度: 每周一 00:10 (北京时间)');
}

/**
 * 手动触发每日复盘
 */
export async function triggerDailyReview(): Promise<void> {
  await runDailyReview();
}

/**
 * 手动触发每周复盘
 */
export async function triggerWeeklyReview(): Promise<void> {
  await runWeeklyReview();
}
