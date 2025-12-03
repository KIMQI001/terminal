/**
 * 清算数据客户端
 * 从 kline-server 的 CoinAnk relay 获取清算数据
 */

import { config } from '../config';

export interface LiquidationBar {
  price: number;
  amount: number;
  side: 'long' | 'short';
}

export interface LiquidationData {
  symbol: string;
  interval: string;
  levels: LiquidationBar[];
  currentPrice?: number;
  timestamp?: string;
}

interface RelayResponse {
  success: boolean;
  data?: {
    list?: Array<{
      price: number;
      liqLongUsd?: number;
      liqShortUsd?: number;
    }>;
  };
  error?: string;
  symbol: string;
  interval: string;
  timestamp?: string;
}

/**
 * 获取清算数据
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

    const data = await response.json() as RelayResponse;

    if (!data.success || !data.data?.list) {
      console.warn(`[LiquidationClient] 获取 ${baseCoin} 清算数据失败:`, data.error);
      return null;
    }

    // 转换数据格式
    const levels: LiquidationBar[] = [];

    for (const item of data.data.list) {
      if (item.liqLongUsd && item.liqLongUsd > 0) {
        levels.push({
          price: item.price,
          amount: item.liqLongUsd,
          side: 'long',
        });
      }
      if (item.liqShortUsd && item.liqShortUsd > 0) {
        levels.push({
          price: item.price,
          amount: item.liqShortUsd,
          side: 'short',
        });
      }
    }

    return {
      symbol: data.symbol,
      interval: data.interval,
      levels,
      timestamp: data.timestamp,
    };
  } catch (error) {
    console.error(`[LiquidationClient] 获取 ${baseCoin} 清算数据失败:`, error);
    return null;
  }
}

/**
 * 提取关键清算水平
 * 返回最密集的多头和空头清算区域
 */
export function extractKeyLiquidationLevels(
  data: LiquidationData,
  currentPrice: number,
  topN: number = 5
): {
  longLiquidation: { price: number; amount: number }[];
  shortLiquidation: { price: number; amount: number }[];
} {
  // 分离多头和空头清算
  const longLevels = data.levels
    .filter(l => l.side === 'long' && l.price < currentPrice)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topN);

  const shortLevels = data.levels
    .filter(l => l.side === 'short' && l.price > currentPrice)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topN);

  return {
    longLiquidation: longLevels.map(l => ({ price: l.price, amount: l.amount })),
    shortLiquidation: shortLevels.map(l => ({ price: l.price, amount: l.amount })),
  };
}
