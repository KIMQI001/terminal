/**
 * 清算数据客户端
 * 从 liquidation-service (端口 3004) 获取清算数据
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
  longPeaks: LiquidationLevel[];   // 多头清算峰值
  shortPeaks: LiquidationLevel[];  // 空头清算峰值
  timestamp?: string;
}

// liquidation-service API 响应格式
interface LiqServiceResponse {
  success: boolean;
  data?: {
    longTop: Array<{ price: number; amount: number }>;
    shortTop: Array<{ price: number; amount: number }>;
  };
  error?: string;
}

// ============================================
// 数据获取
// ============================================

/**
 * 获取清算数据
 */
export async function fetchLiquidation(
  baseCoin: string,
  interval: string = '1d'
): Promise<LiquidationData | null> {
  const url = `${config.liqService.url}/api/liqmap/top?symbol=${baseCoin}&limit=10`;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json() as LiqServiceResponse;

      if (!result.success || !result.data) {
        console.warn(`[LiquidationClient] 获取 ${baseCoin} 清算数据失败:`, result.error);
        return null;
      }

      const { longTop, shortTop } = result.data;

      // 转换为 LiquidationData 格式
      // 注意：longTop 的 price 是多头清算触发价（在当前价下方）
      // shortTop 的 price 是空头清算触发价（在当前价上方）
      const longPeaks: LiquidationLevel[] = longTop.map(l => ({
        price: l.price,
        volume: l.amount,
        side: 'long' as const,
      }));

      const shortPeaks: LiquidationLevel[] = shortTop.map(s => ({
        price: s.price,
        volume: s.amount,
        side: 'short' as const,
      }));

      // 从 liqService 获取的 longTop/shortTop 数据不包含当前价，
      // 需要估算或从其他接口获取，这里设为 0 让调用方处理
      const currentPrice = 0;

      console.log(`[LiquidationClient] ${baseCoin}@${interval} - 多头峰值: ${longPeaks.length}, 空头峰值: ${shortPeaks.length}`);

      return {
        symbol: baseCoin,
        interval,
        currentPrice,
        longPeaks,
        shortPeaks,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (attempt < maxRetries) {
        console.log(`[LiquidationClient] 请求失败，第 ${attempt + 1} 次重试...`);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      console.error(`[LiquidationClient] 获取 ${baseCoin} 清算数据失败:`, error);
      return null;
    }
  }

  return null;
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
