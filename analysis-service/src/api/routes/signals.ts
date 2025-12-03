/**
 * 信号 API 路由
 */

import { Router, Request, Response } from 'express';
import {
  getPendingSignals,
  getEnteredSignals,
  getCompletedSignals,
  getSignalsByDateRange,
  getSignalById,
  getSignalStats,
} from '../../signals/signalStore';
import { getLastNDaysRange } from '../../signals/performanceCalc';

export const signalRoutes = Router();

/**
 * GET /api/signals
 * 获取信号列表
 * Query: status (pending|entered|completed|all), days (number)
 */
signalRoutes.get('/', (req: Request, res: Response) => {
  try {
    const status = req.query.status as string || 'all';
    const days = parseInt(req.query.days as string) || 30;

    let signals;

    switch (status) {
      case 'pending':
        signals = getPendingSignals();
        break;
      case 'entered':
        signals = getEnteredSignals();
        break;
      case 'completed':
        const { start, end } = getLastNDaysRange(days);
        signals = getCompletedSignals(start, end);
        break;
      case 'all':
      default:
        const range = getLastNDaysRange(days);
        signals = getSignalsByDateRange(range.start, range.end);
        break;
    }

    // 序列化 Date 对象
    const serialized = signals.map(s => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
      enteredAt: s.enteredAt?.toISOString() || null,
      exitedAt: s.exitedAt?.toISOString() || null,
    }));

    res.json({
      success: true,
      count: signals.length,
      data: serialized,
    });
  } catch (error) {
    console.error('[API] GET /signals error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/signals/stats
 * 获取信号统计概览
 * Query: days (number)
 */
signalRoutes.get('/stats', (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const { start, end } = getLastNDaysRange(days);
    const stats = getSignalStats(start, end);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[API] GET /signals/stats error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/signals/:id
 * 获取单个信号详情
 */
signalRoutes.get('/:id', (req: Request, res: Response) => {
  try {
    const signal = getSignalById(req.params.id);

    if (!signal) {
      return res.status(404).json({
        success: false,
        error: 'Signal not found',
      });
    }

    // 序列化 Date 对象
    const serialized = {
      ...signal,
      createdAt: signal.createdAt.toISOString(),
      enteredAt: signal.enteredAt?.toISOString() || null,
      exitedAt: signal.exitedAt?.toISOString() || null,
    };

    res.json({
      success: true,
      data: serialized,
    });
  } catch (error) {
    console.error('[API] GET /signals/:id error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
