/**
 * AI 托管 API 路由
 */

import { Router, Request, Response } from 'express';
import {
  getAIManagement,
  startAIManagement,
  stopAIManagement,
} from '../../ai/aiManagementStore';

const router = Router();

/**
 * GET /api/ai-management
 * 获取用户的托管配置
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.query.userId as string);
    const symbol = (req.query.symbol as string) || 'BTCUSDC';

    if (!userId) {
      res.json({ success: false, error: '缺少 userId 参数' });
      return;
    }

    const config = getAIManagement(userId, symbol);

    res.json({
      success: true,
      data: config || {
        isActive: false,
        baseMargin: 100,
      },
    });
  } catch (error) {
    console.error('[AI Management] GET error:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

/**
 * POST /api/ai-management/start
 * 启动托管
 */
router.post('/start', (req: Request, res: Response) => {
  try {
    const { userId, symbol = 'BTCUSDC', baseMargin = 100 } = req.body;

    if (!userId) {
      res.json({ success: false, error: '缺少 userId 参数' });
      return;
    }

    const config = startAIManagement(userId, symbol, baseMargin);

    res.json({ success: true, data: config });
  } catch (error) {
    console.error('[AI Management] POST /start error:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

/**
 * POST /api/ai-management/stop
 * 停止托管
 */
router.post('/stop', (req: Request, res: Response) => {
  try {
    const { userId, symbol = 'BTCUSDC' } = req.body;

    if (!userId) {
      res.json({ success: false, error: '缺少 userId 参数' });
      return;
    }

    const config = stopAIManagement(userId, symbol);

    res.json({ success: true, data: config });
  } catch (error) {
    console.error('[AI Management] POST /stop error:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

export default router;
