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

  // 算 tier:看上一个未填充的同方向 FVG
  // - 找 live 数组里前一个同方向 FVG(按时间顺序)
  // - 如果前一个 FVG 之后到当前 FVG 之间出现新 strict HH(对 FR)/ strict LL(对 FS)
  //   → tier = 1(段切换)
  // - 否则 → tier = 前一个 FVG.tier + 1(顺序走)
  //   包括:strict HH 找不到(当作没新 HH,继续顺序走)
  //   例:FR1 → FR2(中间无 HH)→ FR3(中间无 HH)→ 新 HH → 下个 FR1
  for (let i = 0; i < live.length; i++) {
    const fvg = live[i];
    const wantType = fvg.type === 'bullish' ? 'low' : 'high';
    const wantClass = fvg.type === 'bullish' ? 'LL' : 'HH';

    // 找 live 数组里前一个同方向 FVG
    let prev: typeof fvg | null = null;
    for (let k = i - 1; k >= 0; k--) {
      if (live[k].type === fvg.type) {
        prev = live[k];
        break;
      }
    }

    if (!prev) {
      // 第一个 FVG,或前面没有同方向 FVG
      fvg.tier = 1;
      continue;
    }

    // 检查 [prev.candleIndex, fvg.candleIndex) 区间内是否有新 strict HH/LL
    // 找不到 strict(没有)就当作"没新 HH" → 不重置 → 顺序走
    let hasNewRef = false;
    let refFound: number | null = null;
    for (const sp of swingPoints) {
      if (
        sp.type === wantType &&
        sp.classification === wantClass &&
        sp.index > prev.candleIndex &&
        sp.index < fvg.candleIndex
      ) {
        hasNewRef = true;
        refFound = sp.index;
        break;
      }
    }

    // 有新 strict HH/LL → tier=1;否则 → tier=prev+1(顺序走)
    fvg.tier = hasNewRef ? 1 : prev.tier + 1;

    // 调试 log(临时):每个 FVG 的 tier 决策细节
    if (typeof window !== 'undefined' && (window as any).__fvgDebug) {
      const totalSwings = swingPoints.length;
      const strictMatches = swingPoints.filter(
        (sp) => sp.type === wantType && sp.classification === wantClass
      ).length;
      console.log(
        `[FVG tier] type=${fvg.type} idx=${fvg.candleIndex} ` +
        `prev=${prev.candleIndex} prev.tier=${prev.tier} ` +
        `hasNewRef=${hasNewRef}` + (refFound !== null ? ` refFound@${refFound}` : '') +
        ` → tier=${fvg.tier}` +
        ` (swingPoints: ${totalSwings}, strict ${wantClass}: ${strictMatches})`
      );
    }
  }

  return live;
}
