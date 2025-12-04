/**
 * 守塔托管 API 路由
 * 提供托管配置的增删改查接口
 */

import { Router, Request, Response } from 'express';
import {
  getManagement,
  getActiveManagements,
  upsertManagement,
  startManagement,
  stopManagement,
  getRecentRecords,
  getManagementStats,
  TowerManagementConfig,
} from '../../tower/towerManagementStore';

export const towerManagementRoutes = Router();

/**
 * GET /api/tower-management
 * 获取托管配置
 * Query: { userId: number, symbol: string }
 */
towerManagementRoutes.get('/', (req: Request, res: Response) => {
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
    console.error('[TowerManagement API] GET error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * POST /api/tower-management
 * 创建或更新托管配置
 * Body: TowerManagementConfig (部分字段)
 */
towerManagementRoutes.post('/', (req: Request, res: Response) => {
  try {
    const {
      userId,
      symbol,
      isActive = false,
      intervalMinutes = 5,
      baseMargin = 100,
      marginIncrement = 0,
      towerLayers = 3,
      bullishStartLayer = 1,
      bearishStartLayer = 1,
      minSpacingRatio = 5,
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
      isActive,
      intervalMinutes,
      baseMargin,
      marginIncrement,
      towerLayers,
      bullishStartLayer,
      bearishStartLayer,
      minSpacingRatio,
    });

    console.log(`[TowerManagement API] 更新配置: userId=${userId}, symbol=${symbol}, active=${isActive}`);

    res.json({
      success: true,
      management: config,
    });
  } catch (error) {
    console.error('[TowerManagement API] POST error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * POST /api/tower-management/start
 * 启动托管
 * Body: { userId: number, symbol: string, intervalMinutes?: number }
 */
towerManagementRoutes.post('/start', (req: Request, res: Response) => {
  try {
    const { userId, symbol, intervalMinutes = 5 } = req.body;

    if (!userId || !symbol) {
      res.status(400).json({
        success: false,
        error: '缺少 userId 或 symbol',
      });
      return;
    }

    // 确保配置存在
    let config = getManagement(userId, symbol);
    if (!config) {
      // 创建默认配置
      config = upsertManagement({
        userId,
        symbol,
        isActive: true,
        intervalMinutes,
        baseMargin: 100,
        marginIncrement: 0,
        towerLayers: 3,
        bullishStartLayer: 1,
        bearishStartLayer: 1,
        minSpacingRatio: 5,
      });
    } else {
      // 启动现有配置
      startManagement(userId, symbol, intervalMinutes);
      config = getManagement(userId, symbol)!;
    }

    console.log(`[TowerManagement API] 启动托管: userId=${userId}, symbol=${symbol}`);

    res.json({
      success: true,
      management: config,
      message: '托管已启动',
    });
  } catch (error) {
    console.error('[TowerManagement API] POST /start error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * POST /api/tower-management/stop
 * 停止托管
 * Body: { userId: number, symbol: string }
 */
towerManagementRoutes.post('/stop', (req: Request, res: Response) => {
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

    console.log(`[TowerManagement API] 停止托管: userId=${userId}, symbol=${symbol}`);

    res.json({
      success: true,
      message: '托管已停止',
    });
  } catch (error) {
    console.error('[TowerManagement API] POST /stop error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * GET /api/tower-management/active
 * 获取所有活跃的托管
 */
towerManagementRoutes.get('/active', (_req: Request, res: Response) => {
  try {
    const activeManagements = getActiveManagements();

    res.json({
      success: true,
      data: activeManagements,
      count: activeManagements.length,
    });
  } catch (error) {
    console.error('[TowerManagement API] GET /active error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});

/**
 * GET /api/tower-management/records
 * 获取执行记录
 * Query: { userId: number, symbol: string, limit?: number }
 */
towerManagementRoutes.get('/records', (req: Request, res: Response) => {
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
    console.error('[TowerManagement API] GET /records error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '服务器错误',
    });
  }
});
