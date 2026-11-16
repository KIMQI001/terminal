import type { Candle } from "@/types/chart";

/** 各周期对应的秒数（K 线 time 是「开盘时间」，time + tfSec <= now 才算收盘） */
export const TF_SECONDS: Record<string, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "6h": 21600,
  "8h": 28800,
  "12h": 43200,
  "1d": 86400,
  "3d": 259200,
  "4d": 345600,
  "1w": 604800,
};

export function tfSeconds(timeframe: string): number {
  return TF_SECONDS[timeframe] ?? 900;
}

export interface ReplayWindow {
  /** 全量快照（结束回放时原样恢复） */
  fullCandles: Candle[];
  /** 回放窗口（已收盘的最近 N 根） */
  bars: Candle[];
  /** bars[0] 在 fullCandles 中的下标 */
  windowStartIndex: number;
  /** 被剔除的未收盘 K 数量 */
  closedCount: number;
}

/**
 * 选出回放窗口：
 * 1) 剔除「未收盘的形成中 K」（time + tfSec > now 的那根）
 * 2) 取最后 barCount 根已收盘 K
 */
export function pickReplayWindow(
  fullCandles: Candle[],
  timeframe: string,
  barCount: number,
  nowSec: number = Math.floor(Date.now() / 1000)
): ReplayWindow {
  const tf = tfSeconds(timeframe);
  const closed: Candle[] = [];
  let windowStartIndex = 0;

  for (let i = 0; i < fullCandles.length; i++) {
    if (fullCandles[i].time + tf <= nowSec) {
      closed.push(fullCandles[i]);
      windowStartIndex = i;
    }
  }

  const bars = closed.slice(-barCount);
  // bars 起点在全量数组中的真实下标
  const firstTime = bars.length > 0 ? bars[0].time : null;
  const realStart =
    firstTime === null
      ? fullCandles.length
      : fullCandles.findIndex((c) => c.time === firstTime);

  return {
    fullCandles,
    bars,
    windowStartIndex: realStart >= 0 ? realStart : windowStartIndex,
    closedCount: fullCandles.length - closed.length,
  };
}
