/**
 * 守塔战绩 API
 */

import { Router, Request, Response } from 'express';
import { getClosedOrders, getPerformanceStats } from '../../order/pendingOrderStore';

export const towerPerformanceRoutes = Router();

/**
 * GET /api/tower-performance/stats
 * 获取战绩统计
 */
towerPerformanceRoutes.get('/stats', (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const symbol = req.query.symbol as string;

    const stats = getPerformanceStats({ days, symbol });

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[TowerPerformance] GET /stats error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * GET /api/tower-performance/orders
 * 获取战绩列表
 */
towerPerformanceRoutes.get('/orders', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const days = parseInt(req.query.days as string) || 30;
    const symbol = req.query.symbol as string;

    const orders = getClosedOrders({ days, symbol, limit });

    // 格式化输出
    const formattedOrders = orders.map(order => ({
      id: order.id,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      positionSide: order.positionSide,
      quantity: order.quantity,
      entryPrice: order.filledPrice || order.entryPrice,
      closePrice: order.closePrice,
      closeReason: order.closeReason,
      pnlAmount: order.pnlAmount,
      pnlPercent: order.pnlPercent,
      actualRR: order.actualRR,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      filledAt: order.filledAt,
      closedAt: order.closedAt,
    }));

    res.json({
      success: true,
      data: formattedOrders,
    });
  } catch (error) {
    console.error('[TowerPerformance] GET /orders error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});
