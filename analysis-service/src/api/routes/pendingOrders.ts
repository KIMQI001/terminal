/**
 * 待处理订单 API 路由
 * 用于存储守塔订单的止盈止损信息
 */

import { Router, Request, Response } from 'express';
import {
  addPendingOrder,
  getPendingOrderByClientId,
  getAllPendingOrders,
  getActiveOrders,
  deletePendingOrder,
} from '../../order/pendingOrderStore';

export const pendingOrdersRoutes = Router();

// POST: 添加待处理订单
pendingOrdersRoutes.post('/', (req: Request, res: Response) => {
  try {
    const {
      clientOrderId,
      symbol,
      side,
      positionSide,
      quantity,
      entryPrice,
      stopLoss,
      takeProfit,
    } = req.body;

    // 验证必填字段
    if (!clientOrderId || !symbol || !side || !positionSide || !quantity || !stopLoss || !takeProfit) {
      res.status(400).json({
        success: false,
        error: '缺少必填字段',
      });
      return;
    }

    // 保存到数据库
    addPendingOrder({
      clientOrderId,
      symbol,
      side,
      positionSide,
      quantity: parseFloat(quantity),
      entryPrice: entryPrice ? parseFloat(entryPrice) : 0,
      stopLoss: parseFloat(stopLoss),
      takeProfit: parseFloat(takeProfit),
    });

    console.log(`[PendingOrders] 保存待处理订单: ${clientOrderId}`);

    res.json({
      success: true,
      message: '待处理订单已保存',
      clientOrderId,
    });
  } catch (error) {
    console.error('[PendingOrders] POST error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

// GET: 获取待处理订单
pendingOrdersRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { clientOrderId, status, symbol } = req.query;

    if (clientOrderId) {
      // 获取单个订单
      const order = getPendingOrderByClientId(clientOrderId as string);
      if (order) {
        res.json({ success: true, order });
      } else {
        res.status(404).json({
          success: false,
          error: '订单不存在',
        });
      }
    } else if (status === 'active') {
      // 获取活跃订单（pending 或 filled 未平仓）
      console.log(`[PendingOrders] 查询活跃订单: symbol=${symbol}`);
      const orders = getActiveOrders({
        symbol: symbol as string | undefined,
        limit: 50,
      });
      console.log(`[PendingOrders] 找到 ${orders.length} 个活跃订单`);
      // 格式化输出
      const data = orders.map(order => ({
        id: order.id,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        quantity: order.quantity,
        entryPrice: order.entryPrice,
        filledPrice: order.filledPrice,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        status: order.status,
        createdAt: order.createdAt,
        filledAt: order.filledAt,
      }));
      res.json({ success: true, data });
    } else {
      // 获取所有待处理订单
      const orders = getAllPendingOrders();
      res.json({ success: true, orders });
    }
  } catch (error) {
    console.error('[PendingOrders] GET error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

// DELETE: 删除待处理订单
pendingOrdersRoutes.delete('/', (req: Request, res: Response) => {
  try {
    const { clientOrderId } = req.query;

    if (!clientOrderId) {
      res.status(400).json({
        success: false,
        error: '缺少 clientOrderId',
      });
      return;
    }

    const deleted = deletePendingOrder(clientOrderId as string);

    if (deleted) {
      console.log(`[PendingOrders] 删除待处理订单: ${clientOrderId}`);
      res.json({
        success: true,
        message: '待处理订单已删除',
      });
    } else {
      res.status(404).json({
        success: false,
        error: '订单不存在',
      });
    }
  } catch (error) {
    console.error('[PendingOrders] DELETE error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});
