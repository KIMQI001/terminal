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
import { getManagement } from '../../tower/towerManagementStore';

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
/**
 * GET /api/analyze/tower
 * 获取所有周期的塔块数据（FVG/OB/OTE）
 * Query: { symbol: string }
 */
analyzeRoutes.get('/tower', async (req: Request, res: Response) => {
  try {
    const symbol = (req.query.symbol as string) || 'BTCUSDC';
    const userId = parseInt(req.query.userId as string) || 0;

    // 优先用 management 的 enabledTimeframes（用户配置过）
    // 未配置或 userId=0 时 fall back 到默认 5 个 TF
    let timeframes: Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];
    if (userId > 0) {
      const m = getManagement(userId, symbol);
      if (m) {
        try {
          const tfs = JSON.parse(m.enabledTimeframes);
          if (Array.isArray(tfs) && tfs.length > 0) {
            timeframes = tfs.filter((t) =>
              ['5m', '15m', '1h', '4h', '1d'].includes(t),
            ) as Timeframe[];
            if (timeframes.length === 0) {
              timeframes = ['5m', '15m', '1h', '4h', '1d'];
            }
          }
        } catch {
          // 解析失败用默认
        }
      }
    }

    console.log(`[API] 塔块数据请求: ${symbol}`);

    // BTC/ETH 请求 5000 根，其他交易对请求 1000 根（与前端保持一致）
    const baseCoin = symbol.replace('USDC', '').replace('USDT', '');
    const limit = (baseCoin === 'BTC' || baseCoin === 'ETH') ? 5000 : 1000;

    // 并行获取所有周期的 K 线数据
    const candlesPromises = timeframes.map(tf => fetchKlines(symbol, tf, limit));
    const allCandles = await Promise.all(candlesPromises);

    // 分析每个周期的 ICT 指标
    const towerBlocks: Array<{
      id: string;
      type: 'bullish' | 'bearish';
      source: 'FVG' | 'OB' | 'OTE';
      timeframe: string;
      high: number;
      low: number;
      entry: number;
      fillPercent: number;
    }> = [];

    // 获取当前价格
    const latestCandles = allCandles[0]; // 5m 最新
    const currentPrice = latestCandles.length > 0 ? latestCandles[latestCandles.length - 1].close : 0;

    for (let i = 0; i < timeframes.length; i++) {
      const tf = timeframes[i];
      const candles = allCandles[i];

      if (candles.length < 50) continue;

      const ictResult = analyzeICT(candles, symbol, tf);

      // 收集 FVG（填充度 < 80%）
      for (const fvg of ictResult.fvgs) {
        if (!fvg.filled && fvg.fillPercentage < 80) {
          towerBlocks.push({
            id: `fvg-${tf}-${fvg.time}`,
            type: fvg.type,
            source: 'FVG',
            timeframe: tf,
            high: fvg.high,
            low: fvg.low,
            entry: fvg.fib22,
            fillPercent: fvg.fillPercentage,
          });
        }
      }

      // 收集 OB（不限填充度，但未被触发）
      for (const ob of ictResult.orderBlocks) {
        if (!ob.mitigated) {
          towerBlocks.push({
            id: `ob-${tf}-${ob.startTime}`,
            type: ob.type,
            source: 'OB',
            timeframe: tf,
            high: ob.high,
            low: ob.low,
            entry: ob.fib22,
            fillPercent: ob.fillPercentage,
          });
        }
      }

      // 收集 OTE（ictAnalyzer 已过滤历史填充和价格位置）
      for (const ote of ictResult.oteZones) {
        // 计算填充度
        const zoneHeight = Math.abs(ote.fib618 - ote.fib786);
        let fillPercent = 0;

        if (zoneHeight > 0) {
          if (ote.type === 'bullish') {
            if (currentPrice >= ote.fib618) fillPercent = 0;
            else if (currentPrice <= ote.fib786) fillPercent = 100;
            else fillPercent = ((ote.fib618 - currentPrice) / zoneHeight) * 100;
          } else {
            if (currentPrice <= ote.fib618) fillPercent = 0;
            else if (currentPrice >= ote.fib786) fillPercent = 100;
            else fillPercent = ((currentPrice - ote.fib618) / zoneHeight) * 100;
          }
        }

        // OTE 使用与 FVG 相同的 80% 过滤
        if (fillPercent < 80) {
          towerBlocks.push({
            id: `ote-${tf}-${ote.startTime}`,
            type: ote.type,
            source: 'OTE',
            timeframe: tf,
            high: ote.type === 'bullish' ? ote.fib618 : ote.fib786,
            low: ote.type === 'bullish' ? ote.fib786 : ote.fib618,
            entry: ote.fib675,
            fillPercent,
          });
        }
      }
    }

    // 过滤塔块：
    // 1. bearish 塔块入场点必须 > 当前价格（做空需要价格上涨到阻力区）
    // 2. bullish 塔块入场点必须 < 当前价格（做多需要价格下跌到支撑区）
    // 3. 只保留当前价格上下 20000 点范围内的塔块
    const PRICE_RANGE = 20000;
    const filteredBlocks = towerBlocks.filter(block => {
      const distanceFromPrice = Math.abs(block.entry - currentPrice);
      if (distanceFromPrice > PRICE_RANGE) return false;

      if (block.type === 'bearish') {
        // 空塔块：入场点必须在当前价格上方
        return block.entry > currentPrice;
      } else {
        // 多塔块：入场点必须在当前价格下方
        return block.entry < currentPrice;
      }
    });

    // 去重：入场价格相近（50点内）的同类型塔块只保留一个
    // 优先保留：1. 更高周期 2. 填充度更低
    const DEDUP_THRESHOLD = 50; // 50点内视为重复
    const timeframePriority: Record<string, number> = {
      '1d': 5, '4h': 4, '1h': 3, '15m': 2, '5m': 1
    };

    const dedupedBlocks = filteredBlocks.reduce((acc, block) => {
      // 查找是否已有相近入场价的同类型塔块
      const existingIndex = acc.findIndex(b =>
        b.type === block.type &&
        Math.abs(b.entry - block.entry) < DEDUP_THRESHOLD
      );

      if (existingIndex === -1) {
        // 没有重复，直接添加
        acc.push(block);
      } else {
        // 有重复，比较优先级
        const existing = acc[existingIndex];
        const existingPriority = timeframePriority[existing.timeframe] || 0;
        const newPriority = timeframePriority[block.timeframe] || 0;

        // 优先保留更高周期，同周期保留填充度更低的
        if (newPriority > existingPriority ||
            (newPriority === existingPriority && block.fillPercent < existing.fillPercent)) {
          acc[existingIndex] = block;
        }
      }

      return acc;
    }, [] as typeof filteredBlocks);

    res.json({
      success: true,
      data: {
        symbol,
        currentPrice,
        blocks: dedupedBlocks,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[API] GET /analyze/tower error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

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
