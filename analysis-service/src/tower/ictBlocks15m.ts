/**
 * 15m ICT 塔块检测主入口
 * 复刻前端 src/lib/chart/indicators/ 的算法，用于实际交易
 *
 * 算法与 towerBlocksFetcher.ts::fetchTowerBlocks 一致使用，
 * 但 ictBlocks15m 完全照搬前端实现，便于和前端 chart 对照
 */

import { fetchKlines } from '../data/klineClient';
import { detectSwings } from './ictBlocks15m.swing';
import { detectFVGs } from './ictBlocks15m.fvg';
import { detectOrderBlocks } from './ictBlocks15m.ob';
import { detectOTEZones } from './ictBlocks15m.ote';
import { Candle, TowerBlock, DetectionResult } from './ictBlocks15m.types';

/**
 * 获取并检测 15m ICT 塔块
 * @param symbol 交易对，如 BTCUSDC
 * @param limit K 线根数（默认 1000，BTC/ETH 建议 2000）
 */
export async function detect15mBlocks(
  symbol: string,
  limit: number = 1000
): Promise<DetectionResult | null> {
  try {
    console.log(`[IctBlocks15m] 获取 ${symbol} 15m K线 (limit=${limit})`);

    const candles: Candle[] = await fetchKlines(symbol, '15m', limit);

    if (candles.length < 50) {
      console.error(`[IctBlocks15m] K线数量不足: ${candles.length}`);
      return null;
    }

    const currentPrice = candles[candles.length - 1].close;
    console.log(`[IctBlocks15m] 当前价格: ${currentPrice}, K线数: ${candles.length}`);

    // 1. 检测 swing points（左2右2, minSwingPercent=0.5）
    const swingPoints = detectSwings(candles, 2, 2, 0.5);
    console.log(`[IctBlocks15m] Swing points: ${swingPoints.length}`);

    // 2. 检测 FVG（minGapPercent=0.1, fill<80%, 最近15条）
    const fvgs = detectFVGs(candles, 0.1);
    console.log(`[IctBlocks15m] FVG: ${fvgs.length}`);

    // 3. 检测 OB（length=10, showBull/Bear=3）
    const orderBlocks = detectOrderBlocks(candles, 10, 3, 3, false);
    console.log(`[IctBlocks15m] OrderBlocks: ${orderBlocks.length}`);

    // 4. 检测 OTE（maxZones=3）
    const oteZones = detectOTEZones(swingPoints, currentPrice, candles, 3);
    console.log(`[IctBlocks15m] OTE: ${oteZones.length}`);

    // 5. 转换为统一 TowerBlock 格式
    const blocks: TowerBlock[] = [];

    // FVG 入场 = fib22
    for (const fvg of fvgs) {
      blocks.push({
        id: `fvg-15m-${fvg.time}`,
        type: fvg.type,
        source: 'FVG',
        timeframe: '15m',
        high: fvg.high,
        low: fvg.low,
        entry: fvg.fib22,
        fillPercent: fvg.fillPercentage,
      });
    }

    // OB 入场 = fib22
    for (const ob of orderBlocks) {
      blocks.push({
        id: `ob-15m-${ob.startTime}`,
        type: ob.type,
        source: 'OB',
        timeframe: '15m',
        high: ob.high,
        low: ob.low,
        entry: ob.fib22,
        fillPercent: ob.fillPercentage,
      });
    }

    // OTE 入场 = fib675
    for (const ote of oteZones) {
      // 计算当前填充度
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

      blocks.push({
        id: `ote-15m-${ote.startTime}`,
        type: ote.type,
        source: 'OTE',
        timeframe: '15m',
        high: ote.type === 'bullish' ? ote.fib618 : ote.fib786,
        low: ote.type === 'bullish' ? ote.fib786 : ote.fib618,
        entry: ote.fib675,
        fillPercent,
      });
    }

    console.log(`[IctBlocks15m] 汇总塔块: ${blocks.length} 个`);

    return {
      symbol,
      timeframe: '15m',
      currentPrice,
      blocks,
      raw: {
        fvgs,
        orderBlocks,
        oteZones,
        swingPoints,
      },
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[IctBlocks15m] 检测失败:', error);
    return null;
  }
}
