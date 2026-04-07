/**
 * 用户数据流 SSE 路由
 * 通过后端代理 Binance WebSocket，推送持仓和订单更新给前端
 */

import { Router, Request, Response } from 'express';
import { UserDataStreamManager, PositionUpdateEvent, OrderTradeUpdateEvent, UserDataStreamEvent } from '../../order/userDataStream';
import { getFirstBinanceApiConfig } from '../../order/apiConfigReader';

export const userStreamRoutes = Router();

// 存储活跃的 SSE 连接
const activeStreams = new Map<number, {
  manager: UserDataStreamManager;
  response: Response;
}>();

/**
 * GET /api/user-stream/position
 * SSE 持仓实时更新
 */
userStreamRoutes.get('/position', (req: Request, res: Response) => {
  const userId = 1; // TODO: 从认证获取

  // 检查是否已有活跃连接
  if (activeStreams.has(userId)) {
    const existing = activeStreams.get(userId)!;
    existing.response.write('data: {"type":"error","message":"已有活跃连接"}\n\n');
    existing.response.end();
    activeStreams.delete(userId);
  }

  // 获取 API 配置
  const apiConfig = getFirstBinanceApiConfig();
  if (!apiConfig) {
    res.status(500).json({
      success: false,
      error: '没有找到 Binance API 配置',
    });
    return;
  }

  console.log(`[UserStream] 用户 ${userId} 开启持仓 SSE 连接`);

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // 发送心跳
  res.write('data: {"type":"ping"}\n\n');

  // 创建 User Data Stream 管理器
  const manager = new UserDataStreamManager({
    apiKey: apiConfig.config.apiKey,
    apiSecret: apiConfig.config.apiSecret,
    isTestnet: apiConfig.config.isTestnet,
    onOrderUpdate: (event: OrderTradeUpdateEvent) => {
      // 持仓路由不处理订单更新
    },
    onPositionUpdate: (event: PositionUpdateEvent) => {
      const sseEvent: UserDataStreamEvent = {
        type: 'position',
        data: event,
      };
      res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
    },
    onConnected: () => {
      console.log(`[UserStream] 用户 ${userId} Binance WebSocket 已连接`);
      res.write('data: {"type":"connected"}\n\n');
    },
    onDisconnected: () => {
      console.log(`[UserStream] 用户 ${userId} Binance WebSocket 已断开`);
      res.write('data: {"type":"disconnected"}\n\n');
    },
    onError: (error) => {
      console.error(`[UserStream] 用户 ${userId} Binance WebSocket 错误:`, error);
      res.write(`data: {"type":"error","message":"${error.message}"}\n\n`);
    },
  });

  // 保存连接
  activeStreams.set(userId, { manager, response: res });

  // 启动连接
  manager.start().catch((error) => {
    console.error(`[UserStream] 启动失败:`, error);
    res.write(`data: {"type":"error","message":"启动失败: ${error.message}"}\n\n`);
    res.end();
    activeStreams.delete(userId);
  });

  // 客户端断开连接
  req.on('close', () => {
    console.log(`[UserStream] 用户 ${userId} SSE 连接断开`);
    manager.stop();
    activeStreams.delete(userId);
  });
});

/**
 * GET /api/user-stream/order
 * SSE 订单实时更新
 */
userStreamRoutes.get('/order', (req: Request, res: Response) => {
  const userId = 1; // TODO: 从认证获取

  // 检查是否已有活跃连接
  if (activeStreams.has(userId + 1000)) { // 1000 用于区分订单连接
    const existing = activeStreams.get(userId + 1000)!;
    existing.response.write('data: {"type":"error","message":"已有活跃连接"}\n\n');
    existing.response.end();
    activeStreams.delete(userId + 1000);
  }

  // 获取 API 配置
  const apiConfig = getFirstBinanceApiConfig();
  if (!apiConfig) {
    res.status(500).json({
      success: false,
      error: '没有找到 Binance API 配置',
    });
    return;
  }

  console.log(`[UserStream] 用户 ${userId} 开启订单 SSE 连接`);

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // 发送心跳
  res.write('data: {"type":"ping"}\n\n');

  // 创建 User Data Stream 管理器
  const manager = new UserDataStreamManager({
    apiKey: apiConfig.config.apiKey,
    apiSecret: apiConfig.config.apiSecret,
    isTestnet: apiConfig.config.isTestnet,
    onOrderUpdate: (event: OrderTradeUpdateEvent) => {
      const sseEvent: UserDataStreamEvent = {
        type: 'order',
        data: event,
      };
      res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
    },
    onPositionUpdate: (event: PositionUpdateEvent) => {
      // 订单路由不处理持仓更新
    },
    onConnected: () => {
      console.log(`[UserStream] 用户 ${userId} Binance WebSocket 已连接`);
      res.write('data: {"type":"connected"}\n\n');
    },
    onDisconnected: () => {
      console.log(`[UserStream] 用户 ${userId} Binance WebSocket 已断开`);
      res.write('data: {"type":"disconnected"}\n\n');
    },
    onError: (error) => {
      console.error(`[UserStream] 用户 ${userId} Binance WebSocket 错误:`, error);
      res.write(`data: {"type":"error","message":"${error.message}"}\n\n`);
    },
  });

  // 保存连接
  activeStreams.set(userId + 1000, { manager, response: res });

  // 启动连接
  manager.start().catch((error) => {
    console.error(`[UserStream] 启动失败:`, error);
    res.write(`data: {"type":"error","message":"启动失败: ${error.message}"}\n\n`);
    res.end();
    activeStreams.delete(userId + 1000);
  });

  // 客户端断开连接
  req.on('close', () => {
    console.log(`[UserStream] 用户 ${userId} SSE 订单连接断开`);
    manager.stop();
    activeStreams.delete(userId + 1000);
  });
});

/**
 * 获取当前活跃连接数
 */
userStreamRoutes.get('/status', (_req: Request, res: Response) => {
  res.json({
    success: true,
    activeConnections: activeStreams.size,
  });
});
