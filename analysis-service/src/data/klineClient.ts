/**
 * K线数据客户端
 * 从 kline-server 获取 K线数据
 */

import { config } from '../config';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d' | '4d' | '1w';

interface KlineResponse {
  symbol: string;
  timeframe: string;
  klines: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}

/**
 * 获取 K线数据
 */
export async function fetchKlines(
  symbol: string,
  timeframe: Timeframe,
  limit: number = 500
): Promise<Candle[]> {
  const url = `${config.klineServer.restUrl}/api/klines/${symbol}/${timeframe}?limit=${limit}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as KlineResponse;

    // 转换为 Candle 格式
    return data.klines.map(k => ({
      time: k.time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
    }));
  } catch (error) {
    console.error(`[KlineClient] 获取 ${symbol}@${timeframe} 失败:`, error);
    throw error;
  }
}

/**
 * 获取当前价格
 */
export function getCurrentPrice(candles: Candle[]): number {
  if (candles.length === 0) {
    throw new Error('K线数据为空');
  }
  return candles[candles.length - 1].close;
}
