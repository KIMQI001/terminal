/**
 * 清算数据客户端
 * 从 kline-server 的 CoinAnk relay 获取清算数据
 * 复用前端 LiquidationPanel.tsx 的峰值计算逻辑
 */

import { config } from '../config';

// ============================================
// 类型定义
// ============================================

export interface LiquidationLevel {
  price: number;
  volume: number;
  side: 'long' | 'short';
}

export interface LiquidationData {
  symbol: string;
  interval: string;
  currentPrice: number;
  longPeaks: LiquidationLevel[];   // 多头清算峰值（5个）
  shortPeaks: LiquidationLevel[];  // 空头清算峰值（5个）
  timestamp?: string;
}

// CoinAnk 原始数据格式
interface CoinAnkRawData {
  prices?: number[];
  Binance?: number[];
  lastPrice?: number;
  lastIndex?: number;
}

interface RelayResponse {
  success: boolean;
  data?: CoinAnkRawData;
  error?: string;
  symbol: string;
  interval: string;
  timestamp?: string;
}

// ============================================
// 数据获取
// ============================================

/**
 * 获取清算数据并计算峰值
 */
export async function fetchLiquidation(
  baseCoin: string,
  interval: string = '1d'
): Promise<LiquidationData | null> {
  const url = `${config.klineServer.restUrl}/api/coinank/fetch?symbol=${baseCoin}&interval=${interval}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json() as RelayResponse;

    if (!result.success || !result.data) {
      console.warn(`[LiquidationClient] 获取 ${baseCoin} 清算数据失败:`, result.error);
      return null;
    }

    const rawData = result.data;
    const { prices, Binance, lastPrice, lastIndex } = rawData;

    if (!prices || !Binance || lastPrice === undefined || lastIndex === undefined) {
      console.warn(`[LiquidationClient] 数据格式不完整`);
      return null;
    }

    // 解析并聚合清算数据
    const levels = parseLiquidationLevels(prices, Binance, lastIndex);

    // 分离多空并找峰值
    const longLevels = levels.filter(l => l.side === 'long');
    const shortLevels = levels.filter(l => l.side === 'short');

    const longPeaks = findPeaks(longLevels, 5);
    const shortPeaks = findPeaks(shortLevels, 5);

    console.log(`[LiquidationClient] ${baseCoin}@${interval} - 当前价: $${lastPrice}, 多头峰值: ${longPeaks.length}, 空头峰值: ${shortPeaks.length}`);

    return {
      symbol: result.symbol,
      interval: result.interval,
      currentPrice: lastPrice,
      longPeaks,
      shortPeaks,
      timestamp: result.timestamp,
    };
  } catch (error) {
    console.error(`[LiquidationClient] 获取 ${baseCoin} 清算数据失败:`, error);
    return null;
  }
}

// ============================================
// 数据解析
// ============================================

/**
 * 解析 CoinAnk 原始数据
 * - prices: 价格数组
 * - binanceData: 清算量数组（与 prices 对应或 5 倍长度）
 * - lastIndex: 当前价格在 prices 中的索引
 */
function parseLiquidationLevels(
  prices: number[],
  binanceData: number[],
  lastIndex: number
): LiquidationLevel[] {
  const levels: LiquidationLevel[] = [];
  const GROUP_SIZE = 10; // 每 10 个价格点聚合为一组

  // 推断索引乘数（每 5 个元素为一组）
  const indexMultiplier = binanceData.length === prices.length ? 1 : 5;

  // 按价格区间聚合
  for (let groupStart = 0; groupStart < prices.length; groupStart += GROUP_SIZE) {
    const groupEnd = Math.min(groupStart + GROUP_SIZE, prices.length);
    let totalAmount = 0;

    // 聚合该区间内的清算量
    for (let i = groupStart; i < groupEnd; i++) {
      const dataIndex = i * indexMultiplier;
      if (dataIndex < binanceData.length) {
        totalAmount += binanceData[dataIndex] || 0;
      }
    }

    if (totalAmount > 0) {
      // 取区间中点的价格
      const middleIndex = Math.floor((groupStart + groupEnd) / 2);
      const price = prices[middleIndex] || prices[groupStart];

      // 根据 lastIndex 判断多空
      // 价格 < 当前价（索引 < lastIndex）：多头清算区
      // 价格 > 当前价（索引 > lastIndex）：空头清算区
      const side: 'long' | 'short' = middleIndex < lastIndex ? 'long' : 'short';

      levels.push({ price, volume: totalAmount, side });
    }
  }

  return levels;
}

// ============================================
// 峰值计算
// ============================================

/**
 * 找出清算量最大的几个峰值（山峰）
 * - 比相邻价位清算量都大的点
 * - 相邻峰值间距至少 0.2%
 */
function findPeaks(levels: LiquidationLevel[], count: number): LiquidationLevel[] {
  if (levels.length === 0) return [];

  // 按价格排序
  const sorted = [...levels].sort((a, b) => a.price - b.price);

  // 找出所有局部峰值
  const allPeaks: LiquidationLevel[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const prev = sorted[i - 1]?.volume || 0;
    const curr = sorted[i].volume;
    const next = sorted[i + 1]?.volume || 0;

    // 当前值比前后都大，或者是边界且比相邻大
    if (curr > prev && curr > next) {
      allPeaks.push(sorted[i]);
    } else if (i === 0 && curr > next) {
      allPeaks.push(sorted[i]);
    } else if (i === sorted.length - 1 && curr > prev) {
      allPeaks.push(sorted[i]);
    }
  }

  // 按清算量从大到小排序
  allPeaks.sort((a, b) => b.volume - a.volume);

  // 过滤掉距离太近的峰值（保留较大的）
  // 最小距离 = 价格的 0.2%（约 200 点对于 BTC）
  const MIN_DISTANCE_RATIO = 0.002;
  const filteredPeaks: LiquidationLevel[] = [];

  for (const peak of allPeaks) {
    const minDistance = peak.price * MIN_DISTANCE_RATIO;
    const isTooClose = filteredPeaks.some(
      (p) => Math.abs(p.price - peak.price) < minDistance
    );

    if (!isTooClose) {
      filteredPeaks.push(peak);
    }

    if (filteredPeaks.length >= count) break;
  }

  // 按价格排序返回（多头从高到低，空头从低到高更直观）
  return filteredPeaks.sort((a, b) => b.price - a.price);
}

// ============================================
// 工具函数
// ============================================

/**
 * 提取关键清算水平用于 AI Prompt
 */
export function extractKeyLiquidationLevels(
  data: LiquidationData,
  _currentPrice: number,
  _topN: number = 5
): {
  longLiquidation: { price: number; amount: number }[];
  shortLiquidation: { price: number; amount: number }[];
} {
  return {
    longLiquidation: data.longPeaks.map(l => ({ price: l.price, amount: l.volume })),
    shortLiquidation: data.shortPeaks.map(l => ({ price: l.price, amount: l.volume })),
  };
}
