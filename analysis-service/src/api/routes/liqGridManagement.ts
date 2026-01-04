/**
 * 流动性网格托管 API 路由
 * 提供托管配置的增删改查接口
 */

import { Router, Request, Response } from 'express';
import {
  getManagement,
  getActiveManagements,
  upsertManagement,
  stopManagement,
  getRecentRecords,
  getManagementStats,
} from '../../liqGrid/liqGridManagementStore';

export const liqGridManagementRoutes = Router();

/**
 * GET /api/liq-grid-management
 * 获取托管配置
 * Query: { userId: number, symbol: string }
 */
liqGridManagementRoutes.get('/', (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.query.userId as string);
    const symbol = req.query.symbol as string;

    if (!userId || !symbol) {
      res.status(400).json({
        success: false,
        error: '缺少 userId 或 symbol 参数',
      });
      return;
    }

    const config = getManagement(userId, symbol);

    if (!config) {
      // 返回默认配置
      res.json({
        success: true,
        management: null,
        records: [],
        stats: {
          totalExecutions: 0,
          successCount: 0,
          failedCount: 0,
          skippedCount: 0,
        },
      });
      return;
    }

    // 获取执行记录和统计
    const records = getRecentRecords(config.id, 20);
    const stats = getManagementStats(config.id);

    res.json({
      success: true,
      management: config,
      records,
      stats,
    });
  } catch (error) {
    console.error('[LiqGridManagement API] GET error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * POST /api/liq-grid-management
 * 创建或更新托管配置
 * Body: LiqGridManagementConfig (部分字段)
 */
liqGridManagementRoutes.post('/', (req: Request, res: Response) => {
  try {
    const {
      userId,
      symbol,
      exchange,
      isActive = false,
      intervalMinutes = 60,
      baseMargin = 50,
      marginPerLevel = 10,
      leverage = 10,
      maxQuantity = 0,
    } = req.body;

    if (!userId || !symbol) {
      res.status(400).json({
        success: false,
        error: '缺少 userId 或 symbol',
      });
      return;
    }

    const config = upsertManagement({
      userId,
      symbol,
      exchange,
      isActive,
      intervalMinutes,
      baseMargin,
      marginPerLevel,
      leverage,
      maxQuantity,
    });

    console.log(`[LiqGridManagement API] 更新配置: userId=${userId}, symbol=${symbol}, exchange=${exchange || 'binance'}, active=${isActive}, maxQty=${maxQuantity}`);

    res.json({
      success: true,
      management: config,
    });
  } catch (error) {
    console.error('[LiqGridManagement API] POST error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * POST /api/liq-grid-management/start
 * 启动托管
 * Body: { userId, symbol, intervalMinutes, baseMargin, marginPerLevel, leverage }
 */
liqGridManagementRoutes.post('/start', (req: Request, res: Response) => {
  try {
    const {
      userId,
      symbol,
      exchange,
      intervalMinutes = 60,
      baseMargin = 50,
      marginPerLevel = 10,
      leverage = 10,
      maxQuantity = 0,
    } = req.body;

    if (!userId || !symbol) {
      res.status(400).json({
        success: false,
        error: '缺少 userId 或 symbol',
      });
      return;
    }

    // 使用前端传来的参数创建/更新配置并启动
    const config = upsertManagement({
      userId,
      symbol,
      exchange,
      isActive: true,
      intervalMinutes,
      baseMargin,
      marginPerLevel,
      leverage,
      maxQuantity,
    });

    console.log(`[LiqGridManagement API] 启动托管: userId=${userId}, symbol=${symbol}, exchange=${exchange || 'binance'}, baseMargin=${baseMargin}+${marginPerLevel}/层, leverage=${leverage}x, interval=${intervalMinutes}分钟, maxQty=${maxQuantity}`);

    res.json({
      success: true,
      management: config,
      message: '托管已启动',
    });
  } catch (error) {
    console.error('[LiqGridManagement API] POST /start error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * POST /api/liq-grid-management/stop
 * 停止托管
 * Body: { userId: number, symbol: string }
 */
liqGridManagementRoutes.post('/stop', (req: Request, res: Response) => {
  try {
    const { userId, symbol } = req.body;

    if (!userId || !symbol) {
      res.status(400).json({
        success: false,
        error: '缺少 userId 或 symbol',
      });
      return;
    }

    const success = stopManagement(userId, symbol);

    if (!success) {
      res.status(404).json({
        success: false,
        error: '托管配置不存在',
      });
      return;
    }

    console.log(`[LiqGridManagement API] 停止托管: userId=${userId}, symbol=${symbol}`);

    res.json({
      success: true,
      message: '托管已停止',
    });
  } catch (error) {
    console.error('[LiqGridManagement API] POST /stop error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * GET /api/liq-grid-management/active
 * 获取所有活跃的托管
 */
liqGridManagementRoutes.get('/active', (_req: Request, res: Response) => {
  try {
    const activeManagements = getActiveManagements();

    res.json({
      success: true,
      data: activeManagements,
      count: activeManagements.length,
    });
  } catch (error) {
    console.error('[LiqGridManagement API] GET /active error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * GET /api/liq-grid-management/records
 * 获取执行记录
 * Query: { userId: number, symbol: string, limit?: number }
 */
liqGridManagementRoutes.get('/records', (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.query.userId as string);
    const symbol = req.query.symbol as string;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!userId || !symbol) {
      res.status(400).json({
        success: false,
        error: '缺少 userId 或 symbol 参数',
      });
      return;
    }

    const config = getManagement(userId, symbol);
    if (!config) {
      res.json({
        success: true,
        data: [],
        stats: { success: 0, failed: 0, skipped: 0 },
      });
      return;
    }

    const records = getRecentRecords(config.id, limit);
    const stats = getManagementStats(config.id);

    res.json({
      success: true,
      data: records,
      stats,
    });
  } catch (error) {
    console.error('[LiqGridManagement API] GET /records error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});
