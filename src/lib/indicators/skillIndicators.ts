/**
 * ICT 指标共享库 - 可被前端和 API 共用
 * 从 Binance 获取 K 线数据后进行分析
 */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface FVGZone {
  time: string;
  high: number;
  low: number;
  filled: boolean;
  fillPercent: number;
  direction: 'bull' | 'bear';
}

export interface OrderBlock {
  time: string;
  price: number;
  side: 'bull' | 'bear';
  strength: number;
  broken: boolean;
}

export interface SwingPoint {
  time: string;
  price: number;
  type: 'high' | 'low';
}

export interface LiquidityZone {
  time: string;
  price: number;
  type: 'sweep' | 'pool';
  direction: 'bull' | 'bear';
}

// ==================== FVG 检测 ====================
export function detectFVGs(candles: Candle[], minGapPercent: number = 0.1): FVGZone[] {
  const fvgs: FVGZone[] = [];

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c3 = candles[i];

    // Bullish FVG: c3.low > c1.high
    if (c3.low > c1.high) {
      const gapSize = c3.low - c1.high;
      const gapPercent = (gapSize / c1.high) * 100;

      if (gapPercent >= minGapPercent) {
        let filled = false;
        let fillPercent = 0;

        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j].low <= c1.high) {
            filled = true;
            fillPercent = 100;
            break;
          }
          if (candles[j].low <= c3.low) {
            const filledAmount = c3.low - candles[j].low;
            fillPercent = Math.min(100, (filledAmount / gapSize) * 100);
          }
        }

        fvgs.push({
          time: new Date(c1.time).toLocaleString('zh-CN'),
          high: c3.low,
          low: c1.high,
          filled,
          fillPercent,
          direction: 'bull',
        });
      }
    }

    // Bearish FVG: c3.high < c1.low
    if (c3.high < c1.low) {
      const gapSize = c1.low - c3.high;
      const gapPercent = (gapSize / c1.low) * 100;

      if (gapPercent >= minGapPercent) {
        let filled = false;
        let fillPercent = 0;

        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j].high >= c1.low) {
            filled = true;
            fillPercent = 100;
            break;
          }
          if (candles[j].high >= c3.high) {
            const filledAmount = candles[j].high - c3.high;
            fillPercent = Math.min(100, (filledAmount / gapSize) * 100);
          }
        }

        fvgs.push({
          time: new Date(c1.time).toLocaleString('zh-CN'),
          high: c1.low,
          low: c3.high,
          filled,
          fillPercent,
          direction: 'bear',
        });
      }
    }
  }

  return fvgs;
}

// ==================== Swing Points 检测 ====================
export function detectSwingPoints(candles: Candle[], lookback: number = 5): SwingPoint[] {
  const points: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const isHigh = candles.slice(i - lookback, i + lookback + 1).every(
      (c, idx) => idx === lookback || c.high <= candles[i].high
    );
    if (isHigh) {
      points.push({
        time: new Date(candles[i].time).toLocaleString('zh-CN'),
        price: candles[i].high,
        type: 'high',
      });
    }

    const isLow = candles.slice(i - lookback, i + lookback + 1).every(
      (c, idx) => idx === lookback || c.low >= candles[i].low
    );
    if (isLow) {
      points.push({
        time: new Date(candles[i].time).toLocaleString('zh-CN'),
        price: candles[i].low,
        type: 'low',
      });
    }
  }

  return points;
}

// ==================== Order Block 检测 ====================
export function detectOrderBlocks(candles: Candle[], length: number = 10): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  let trend: 'up' | 'down' = 'up';
  let lastSwingHigh = { price: 0, index: 0, time: 0 };
  let lastSwingLow = { price: Infinity, index: 0, time: 0 };

  for (let i = length; i < candles.length; i++) {
    // 更新 swing points
    for (let j = i - length; j <= i; j++) {
      if (candles[j].high > lastSwingHigh.price) {
        lastSwingHigh = { price: candles[j].high, index: j, time: candles[j].time };
      }
      if (candles[j].low < lastSwingLow.price) {
        lastSwingLow = { price: candles[j].low, index: j, time: candles[j].time };
      }
    }

    // 检测突破
    if (candles[i].close > lastSwingHigh.price && trend === 'down') {
      // 向上突破 - 之前是下跌，找最低的 OB
      const obCandles = candles.slice(lastSwingLow.index, i + 1);
      const obLow = Math.min(...obCandles.map(c => c.low));
      const obHigh = Math.max(...obCandles.filter(c => c.low === obLow).map(c => Math.max(c.open, c.close)));
      blocks.push({
        time: new Date(obCandles[0].time).toLocaleString('zh-CN'),
        price: (obLow + obHigh) / 2,
        side: 'bull',
        strength: obCandles.length,
        broken: false,
      });
      trend = 'up';
    }

    if (candles[i].close < lastSwingLow.price && trend === 'up') {
      // 向下突破 - 之前是上涨，找最高的 OB
      const obCandles = candles.slice(lastSwingHigh.index, i + 1);
      const obHigh = Math.max(...obCandles.map(c => c.high));
      const obLow = Math.min(...obCandles.filter(c => c.high === obHigh).map(c => Math.min(c.open, c.close)));
      blocks.push({
        time: new Date(obCandles[0].time).toLocaleString('zh-CN'),
        price: (obLow + obHigh) / 2,
        side: 'bear',
        strength: obCandles.length,
        broken: false,
      });
      trend = 'down';
    }
  }

  return blocks;
}

// ==================== 市场结构检测 ====================
export function detectMarketStructure(candles: Candle[]): {
  trend: 'bull' | 'bear' | 'neutral';
  lastHH?: number;
  lastHL?: number;
  lastLH?: number;
  lastLL?: number;
  structureBroken: boolean;
} {
  const swings = detectSwingPoints(candles, 5);
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'neutral', structureBroken: false };
  }

  const lastHH = highs[highs.length - 1]?.price;
  const lastHL = lows[lows.length - 1]?.price;
  const prevHH = highs[highs.length - 2]?.price;
  const prevHL = lows[lows.length - 2]?.price;

  let trend: 'bull' | 'bear' | 'neutral' = 'neutral';
  let structureBroken = false;

  if (lastHH > prevHH && lastHL > prevHL) {
    trend = 'bull';
  } else if (lastHH < prevHH && lastHL < prevHL) {
    trend = 'bear';
  }

  // 检测结构突破
  if (trend === 'bull' && candles[candles.length - 1].close < lastHL) {
    structureBroken = true;
  }
  if (trend === 'bear' && candles[candles.length - 1].close > lastHH) {
    structureBroken = true;
  }

  return { trend, lastHH, lastHL, lastLH: highs[highs.length - 2]?.price, lastLL: lows[lows.length - 2]?.price, structureBroken };
}

// ==================== 流动性区域检测 ====================
export function detectLiquidityZones(candles: Candle[]): LiquidityZone[] {
  const zones: LiquidityZone[] = [];
  const swings = detectSwingPoints(candles, 5);

  // 价格扫过 swing high/low 视为流动性猎杀
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    // 向上扫掉 swing high
    for (const swing of swings) {
      if (swing.type === 'high') {
        const swingTime = new Date(swing.time).getTime();
        if (curr.time > swingTime && prev.high < swing.price && curr.high > swing.price) {
          zones.push({
            time: swing.time,
            price: swing.price,
            type: 'sweep',
            direction: 'bull',
          });
        }
      } else {
        const swingTime = new Date(swing.time).getTime();
        if (curr.time > swingTime && prev.low > swing.price && curr.low < swing.price) {
          zones.push({
            time: swing.time,
            price: swing.price,
            type: 'sweep',
            direction: 'bear',
          });
        }
      }
    }
  }

  return zones;
}
