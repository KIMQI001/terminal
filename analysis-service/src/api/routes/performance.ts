/**
 * 绩效 API 路由
 */

import { Router, Request, Response } from 'express';
import {
  getDailyStats,
  getWeeklyStats,
  getLastNDaysStats,
  getAllTimeStats,
  getLastNDaysRange,
  PerformanceStats,
} from '../../signals/performanceCalc';
import { getCompletedSignals } from '../../signals/signalStore';

export const performanceRoutes = Router();

/**
 * 收益曲线数据点
 */
interface EquityPoint {
  time: number;
  value: number;
  pnl: number;
  symbol: string;
  timeframe: string;
}

/**
 * 计算累计收益曲线
 */
function calculateEquityCurve(days: number = 30): EquityPoint[] {
  const { start, end } = getLastNDaysRange(days);
  const signals = getCompletedSignals(start, end);

  // 按退出时间排序
  const sorted = [...signals]
    .filter(s => s.exitedAt !== null)
    .sort((a, b) => (a.exitedAt?.getTime() || 0) - (b.exitedAt?.getTime() || 0));

  let cumulative = 0;
  const points: EquityPoint[] = [];

  for (const signal of sorted) {
    if (signal.pnlPercent !== null) {
      cumulative += signal.pnlPercent;
      points.push({
        time: signal.exitedAt!.getTime(),
        value: cumulative,
        pnl: signal.pnlPercent,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
      });
    }
  }

  return points;
}

/**
 * GET /api/performance/daily
 * 获取每日绩效统计
 */
performanceRoutes.get('/daily', (_req: Request, res: Response) => {
  try {
    const stats = getDailyStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[API] GET /performance/daily error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/performance/weekly
 * 获取每周绩效统计
 */
performanceRoutes.get('/weekly', (_req: Request, res: Response) => {
  try {
    const stats = getWeeklyStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[API] GET /performance/weekly error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/performance/stats
 * 获取指定天数的绩效统计
 * Query: days (number, default 30)
 */
performanceRoutes.get('/stats', (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;

    let stats: PerformanceStats;
    if (days === 0) {
      stats = getAllTimeStats();
    } else {
      stats = getLastNDaysStats(days);
    }

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[API] GET /performance/stats error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/performance/equity-curve
 * 获取收益曲线数据
 * Query: days (number, default 30)
 */
performanceRoutes.get('/equity-curve', (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const curve = calculateEquityCurve(days);

    res.json({
      success: true,
      data: curve,
    });
  } catch (error) {
    console.error('[API] GET /performance/equity-curve error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/performance/overview
 * 获取概览统计（用于仪表盘卡片）
 */
performanceRoutes.get('/overview', (_req: Request, res: Response) => {
  try {
    const weeklyStats = getWeeklyStats();
    const allTimeStats = getAllTimeStats();

    res.json({
      success: true,
      data: {
        weekly: {
          totalSignals: weeklyStats.totalSignals,
          completedSignals: weeklyStats.completedSignals,
          winRate: weeklyStats.winRate,
          avgRR: weeklyStats.avgRR,
          expectancy: weeklyStats.expectancy,
          totalPnlPercent: weeklyStats.totalPnlPercent,
        },
        allTime: {
          totalSignals: allTimeStats.totalSignals,
          completedSignals: allTimeStats.completedSignals,
          winRate: allTimeStats.winRate,
          avgRR: allTimeStats.avgRR,
          expectancy: allTimeStats.expectancy,
          totalPnlPercent: allTimeStats.totalPnlPercent,
        },
      },
    });
  } catch (error) {
    console.error('[API] GET /performance/overview error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
