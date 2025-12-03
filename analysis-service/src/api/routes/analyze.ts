/**
 * 手动分析 API 路由
 * 提供手动触发 AI 分析的接口
 */

import { Router, Request, Response } from 'express';
import { fetchKlines, Timeframe } from '../../data/klineClient';
import { fetchLiquidation } from '../../data/liquidationClient';
import { analyzeICT } from '../../analysis/ictAnalyzer';
import { generateTradeSignal, generateReversalSignal, canCallAI, getCallStats } from '../../analysis/aiAnalyzer';
import { analyzeReversal } from '../../analysis/mtfAnalyzer';

export const analyzeRoutes = Router();

// 支持的时间周期
const VALID_TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h', '1d', '1w'];

/**
 * POST /api/analyze
 * 手动触发 AI 分析
 * Body: { symbol: string, timeframe: string }
 */
analyzeRoutes.post('/', async (req: Request, res: Response) => {
  try {
    const { symbol = 'BTCUSDC', timeframe } = req.body;

    // 验证时间周期
    if (!timeframe || !VALID_TIMEFRAMES.includes(timeframe as Timeframe)) {
      return res.status(400).json({
        success: false,
        error: `无效的时间周期，支持: ${VALID_TIMEFRAMES.join(', ')}`,
      });
    }

    // 检查 AI 调用限制
    const check = canCallAI();
    if (!check.allowed) {
      return res.status(429).json({
        success: false,
        error: check.reason,
      });
    }

    console.log(`[API] 手动分析请求: ${symbol}@${timeframe}`);

    // 1. 获取 K 线数据
    const candles = await fetchKlines(symbol, timeframe as Timeframe, 500);
    if (candles.length < 100) {
      return res.status(400).json({
        success: false,
        error: `K线数据不足: ${candles.length} 根`,
      });
    }

    // 2. 获取清算数据
    const baseCoin = symbol.replace('USDC', '').replace('USDT', '');
    const liquidation = await fetchLiquidation(baseCoin, '1d');

    // 3. ICT 分析
    const ictResult = analyzeICT(candles, symbol, timeframe as Timeframe);

    // 4. AI 分析
    const signal = await generateTradeSignal(ictResult, liquidation);
    if (!signal) {
      return res.status(500).json({
        success: false,
        error: 'AI 分析失败',
      });
    }

    // 5. 返回结果
    res.json({
      success: true,
      data: {
        symbol,
        timeframe,
        currentPrice: ictResult.currentPrice,
        trend: ictResult.trend,
        signal: {
          direction: signal.direction,
          confidence: signal.confidence,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          riskReward: signal.riskReward,
          reasoning: signal.reasoning,
          warnings: signal.warnings,
        },
        ict: {
          swingPoints: ictResult.swingPoints.slice(-5),
          fvgs: ictResult.fvgs.filter(f => !f.filled).slice(0, 3),
          oteZones: ictResult.oteZones.filter(o => o.active),
          bos: ictResult.bos.slice(-2),
          choch: ictResult.choch.slice(-1),
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[API] POST /analyze error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/analyze/status
 * 获取 AI 调用状态
 */
analyzeRoutes.get('/status', (_req: Request, res: Response) => {
  try {
    const check = canCallAI();
    const stats = getCallStats();

    res.json({
      success: true,
      data: {
        canCall: check.allowed,
        reason: check.reason || null,
        hourlyUsed: stats.hourly,
        dailyUsed: stats.daily,
        timeframes: VALID_TIMEFRAMES,
      },
    });
  } catch (error) {
    console.error('[API] GET /analyze/status error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/analyze/reversal
 * 反转分析（猜顶/猜底）
 * Body: { symbol: string, mode: 'top' | 'bottom' }
 */
analyzeRoutes.post('/reversal', async (req: Request, res: Response) => {
  try {
    const { symbol = 'BTCUSDC', mode } = req.body;

    // 验证模式
    if (!mode || !['top', 'bottom'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: '无效的模式，支持: top (猜顶), bottom (猜底)',
      });
    }

    // 检查 AI 调用限制
    const check = canCallAI();
    if (!check.allowed) {
      return res.status(429).json({
        success: false,
        error: check.reason,
      });
    }

    console.log(`[API] 反转分析请求: ${symbol}, 模式=${mode}`);

    // 1. 获取清算数据
    const baseCoin = symbol.replace('USDC', '').replace('USDT', '');
    const liquidation = await fetchLiquidation(baseCoin, '1d');

    // 2. 执行反转分析
    const mtfResult = await analyzeReversal(symbol, mode as 'top' | 'bottom', liquidation);

    // 3. 如果有入场点，调用 AI 生成信号
    let signal = null;
    if (mtfResult.reversal.entry) {
      signal = await generateReversalSignal(mtfResult, liquidation);
    }

    // 4. 返回结果
    res.json({
      success: true,
      data: {
        symbol,
        mode,
        currentPrice: mtfResult.currentPrice,
        recentExtreme: mtfResult.recentExtreme,
        trend: mtfResult.reversal.ltfBias,
        signal: signal ? {
          direction: signal.direction,
          confidence: signal.confidence,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          riskReward: signal.riskReward,
          reasoning: signal.reasoning,
          warnings: signal.warnings,
        } : null,
        entry: mtfResult.reversal.entry,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[API] POST /analyze/reversal error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
