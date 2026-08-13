import { Candle, SwingPoint } from "@/types/chart";
import { FVG } from "@/types/indicator";

export interface FVGOptions {
  minGapPercent?: number;
  /** 用于 tier 计算:FR 从最近的 HH 算,FS 从最近的 LL 算 */
  swingPoints?: SwingPoint[];
}

/**
 * Detect Fair Value Gaps (FVG) in price data
 * FVG is created when there's a gap between candle 1's wick and candle 3's wick
 * that is not covered by candle 2's body
 */
export function detectFVGs(
  candles: Candle[],
  options: FVGOptions = {}
): FVG[] {
  const minGapPercent = options.minGapPercent ?? 0.01;
  const swingPoints = options.swingPoints ?? [];
  const fvgs: FVG[] = [];

  for (let i = 2; i < candles.length; i++) {
    const candle1 = candles[i - 2];
    const candle2 = candles[i - 1];
    const candle3 = candles[i];

    // Bullish FVG: Gap between candle1 high and candle3 low
    if (candle3.low > candle1.high) {
      const gapSize = candle3.low - candle1.high;
      const gapPercent = (gapSize / candle1.high) * 100;

      if (gapPercent >= minGapPercent) {
        // Check if FVG has been filled
        let filled = false;
        let fillPercentage = 0;

        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j].low <= candle1.high) {
            filled = true;
            fillPercentage = 100;
            break;
          }
          // Partial fill - 追踪最大填充深度（影线触及也算）
          if (candles[j].low <= candle3.low) {
            const filledAmount = candle3.low - candles[j].low;
            const currentFill = Math.min(100, (filledAmount / gapSize) * 100);
            fillPercentage = Math.max(fillPercentage, currentFill);
          }
        }

        const fvgHigh = candle3.low;
        const fvgLow = candle1.high;
        const fvgSize = fvgHigh - fvgLow;
        // 看涨FVG：入场点在高位 - 22%（价格回调到FVG上部买入）
        const fib22 = fvgHigh - fvgSize * 0.22;

        fvgs.push({
          type: "bullish",
          high: fvgHigh,
          low: fvgLow,
          time: candle2.time,
          filled,
          fillPercentage,
          fib22,
          candleIndex: i,
          tier: 1,  // 占位,后面统一算
        });
      }
    }

    // Bearish FVG: Gap between candle1 low and candle3 high
    if (candle3.high < candle1.low) {
      const gapSize = candle1.low - candle3.high;
      const gapPercent = (gapSize / candle1.low) * 100;

      if (gapPercent >= minGapPercent) {
        // Check if FVG has been filled
        let filled = false;
        let fillPercentage = 0;

        for (let j = i + 1; j < candles.length; j++) {
          if (candles[j].high >= candle1.low) {
            filled = true;
            fillPercentage = 100;
            break;
          }
          // Partial fill - 追踪最大填充深度（影线触及也算）
          if (candles[j].high >= candle3.high) {
            const filledAmount = candles[j].high - candle3.high;
            const currentFill = Math.min(100, (filledAmount / gapSize) * 100);
            fillPercentage = Math.max(fillPercentage, currentFill);
          }
        }

        const fvgHigh = candle1.low;
        const fvgLow = candle3.high;
        const fvgSize = fvgHigh - fvgLow;
        // 看跌FVG：入场点在低位 + 22%（价格回调到FVG下部卖出）
        const fib22 = fvgLow + fvgSize * 0.22;

        fvgs.push({
          type: "bearish",
          high: fvgHigh,
          low: fvgLow,
          time: candle2.time,
          filled,
          fillPercentage,
          fib22,
          candleIndex: i,
          tier: 1,  // 占位,后面统一算
        });
      }
    }
  }

  // Return only recent FVGs with fill < 80%
  const live = fvgs.filter((fvg) => fvg.fillPercentage < 80).slice(-15);

  // 算 tier:从最近的 strict HH(FR)或 strict LL(FS)开始数段内连续同方向 FVG
  // - bullish FVG (FS): 找最近的 strict LL(前一根 K index < fvg.candleIndex 且 classification="LL")
  // - bearish FVG (FR): 找最近的 strict HH(同上,classification="HH")
  // - 数 [refIndex+1, fvg.candleIndex) 区间内同方向 FVG 数 +1 = tier
  // - 段切换:新 strict HH 出现后第一个 FR 重置为 FR1
  // - 找不到 strict HH/LL(早期数据 / 没出现新高)→ tier = 1(新段,无法归类)
  for (let i = 0; i < live.length; i++) {
    const fvg = live[i];
    const wantType = fvg.type === 'bullish' ? 'low' : 'high';
    const wantClass = fvg.type === 'bullish' ? 'LL' : 'HH';

    // 找最近的 strict HH/LL
    let refIndex = -1;
    for (let k = swingPoints.length - 1; k >= 0; k--) {
      const sp = swingPoints[k];
      if (sp.type === wantType && sp.index < fvg.candleIndex) {
        if (sp.classification === wantClass) {
          refIndex = sp.index;
          break;
        }
      }
    }

    // 数 [refIndex+1, fvg.candleIndex) 区间内同方向 FVG 数
    let count = 0;
    if (refIndex !== -1) {
      const start = refIndex + 1;
      for (let k = 0; k < live.length; k++) {
        const other = live[k];
        if (other === fvg) break;  // 遇到自己,停止(只数自己之前的)
        if (other.candleIndex >= start && other.candleIndex < fvg.candleIndex && other.type === fvg.type) {
          count++;
        }
      }
    }
    fvg.tier = count + 1;
  }

  return live;
}
