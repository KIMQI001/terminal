/**
 * 塔块数据获取器
 * 供托管调度器使用，获取塔块数据
 */

import { fetchKlines, Timeframe } from '../data/klineClient';
import { analyzeICT } from '../analysis/ictAnalyzer';

// 塔块数据类型
export interface TowerBlock {
  id: string;
  type: 'bullish' | 'bearish';
  source: 'FVG' | 'OB' | 'OTE';
  timeframe: string;
  high: number;
  low: number;
  entry: number;
  fillPercent: number;
}

// 塔块结果类型
export interface TowerBlocksResult {
  symbol: string;
  currentPrice: number;
  blocks: TowerBlock[];
  timestamp: string;
}

/**
 * 获取塔块数据
 * 与 analyze.ts 中的 /api/analyze/tower 逻辑一致
 */
export async function fetchTowerBlocks(symbol: string): Promise<TowerBlocksResult | null> {
  try {
    const timeframes: Timeframe[] = ['15m', '1h', '4h', '1d'];

    console.log(`[TowerBlocksFetcher] 获取塔块数据: ${symbol}`);

    // BTC/ETH 请求 5000 根，其他交易对请求 1000 根
    const baseCoin = symbol.replace('USDC', '').replace('USDT', '');
    const limit = (baseCoin === 'BTC' || baseCoin === 'ETH') ? 5000 : 1000;

    // 并行获取所有周期的 K 线数据
    const candlesPromises = timeframes.map(tf => fetchKlines(symbol, tf, limit));
    const allCandles = await Promise.all(candlesPromises);

    // 分析每个周期的 ICT 指标
    const towerBlocks: TowerBlock[] = [];

    // 获取当前价格
    const latestCandles = allCandles[0]; // 15m 最新
    const currentPrice = latestCandles.length > 0 ? latestCandles[latestCandles.length - 1].close : 0;

    if (currentPrice === 0) {
      console.error('[TowerBlocksFetcher] 无法获取当前价格');
      return null;
    }

    for (let i = 0; i < timeframes.length; i++) {
      const tf = timeframes[i];
      const candles = allCandles[i];

      if (candles.length < 50) continue;

      const ictResult = analyzeICT(candles, symbol, tf);

      // 收集 FVG（填充度 < 22%）
      for (const fvg of ictResult.fvgs) {
        if (!fvg.filled && fvg.fillPercentage < 22) {
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

      // 收集 OTE
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

        // OTE 使用与 FVG 相同的 22% 过滤
        if (fillPercent < 22) {
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
    // 1. bearish 塔块入场点必须 > 当前价格
    // 2. bullish 塔块入场点必须 < 当前价格
    // 3. 只保留当前价格上下 6000 点范围内的塔块
    const PRICE_RANGE = 6000;
    const filteredBlocks = towerBlocks.filter(block => {
      const distanceFromPrice = Math.abs(block.entry - currentPrice);
      if (distanceFromPrice > PRICE_RANGE) return false;

      if (block.type === 'bearish') {
        return block.entry > currentPrice;
      } else {
        return block.entry < currentPrice;
      }
    });

    // 去重：入场价格相近（50点内）的同类型塔块只保留一个
    const DEDUP_THRESHOLD = 50;
    const timeframePriority: Record<string, number> = {
      '1d': 5, '4h': 4, '1h': 3, '15m': 2
    };

    const dedupedBlocks = filteredBlocks.reduce((acc, block) => {
      const existingIndex = acc.findIndex(b =>
        b.type === block.type &&
        Math.abs(b.entry - block.entry) < DEDUP_THRESHOLD
      );

      if (existingIndex === -1) {
        acc.push(block);
      } else {
        const existing = acc[existingIndex];
        const existingPriority = timeframePriority[existing.timeframe] || 0;
        const newPriority = timeframePriority[block.timeframe] || 0;

        if (newPriority > existingPriority ||
            (newPriority === existingPriority && block.fillPercent < existing.fillPercent)) {
          acc[existingIndex] = block;
        }
      }

      return acc;
    }, [] as TowerBlock[]);

    console.log(`[TowerBlocksFetcher] 获取到 ${dedupedBlocks.length} 个塔块`);

    return {
      symbol,
      currentPrice,
      blocks: dedupedBlocks,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[TowerBlocksFetcher] 获取塔块数据失败:', error);
    return null;
  }
}
