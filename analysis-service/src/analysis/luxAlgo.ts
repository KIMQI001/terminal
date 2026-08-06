/**
 * LuxAlgo 风格的 Pivot Points 检测器
 *
 * 与前端 src/lib/chart/indicators/pivotDetector.ts 完全一致
 * （算法来源：Pivot Points High Low & Missed Reversal Levels [LuxAlgo]）
 *
 * 设计目标：让 analysis-service（守塔）用与前端 TradingChart 相同的 swing
 * 检测逻辑，确保守塔与图上看到的 swing 一致。
 */

export type PivotType = "high" | "low";

export interface RegularPivot {
  type: "regular";
  pivotType: PivotType;
  price: number;
  time: number;
  index: number;
  barIndex: number;
}

export interface MissedPivot {
  type: "missed";
  pivotType: PivotType;
  price: number;
  time: number;
  index: number;
  missedBy: "high" | "low";
  followPrice?: number;
}

export interface PivotResult {
  pivots: RegularPivot[];
  missedPivots: MissedPivot[];
  state: {
    max: number;
    min: number;
    maxIndex: number;
    minIndex: number;
    followMax: number;
    followMin: number;
    followMaxIndex: number;
    followMinIndex: number;
    os: 0 | 1;
    lastPivotPrice: number;
    lastPivotIndex: number;
    lastPivotType: PivotType | null;
  };
}

export function detectPivots(
  candles: Array<{ time: number; high: number; low: number; close: number; open: number; volume: number }>,
  length: number = 20,
  showRegular: boolean = true,
  showMissed: boolean = true
): PivotResult {
  const pivots: RegularPivot[] = [];
  const missedPivots: MissedPivot[] = [];

  if (candles.length < length + 1) {
    return {
      pivots,
      missedPivots,
      state: initState(candles, length),
    };
  }

  let state = initState(candles, length);

  for (let i = length; i < candles.length; i++) {
    const current = candles[i];

    state = updateFollowState(state, candles, i, length);

    // 检测 Pivot High
    const ph = ta_pivothigh(candles, i, length);
    if (ph !== null) {
      const pivotBarIndex = i - length;

      if (showMissed) {
        if (state.os === 1) {
          missedPivots.push({
            type: "missed",
            pivotType: "low",
            price: state.min,
            time: candles[state.minIndex].time,
            index: state.minIndex,
            missedBy: "high",
          });
        }
        if (ph < state.max) {
          missedPivots.push({
            type: "missed",
            pivotType: "high",
            price: state.max,
            time: candles[state.maxIndex].time,
            index: state.maxIndex,
            missedBy: "high",
          });
          if (state.followMin !== state.min) {
            missedPivots.push({
              type: "missed",
              pivotType: "low",
              price: state.followMin,
              time: candles[state.followMinIndex].time,
              index: state.followMinIndex,
              missedBy: "high",
              followPrice: ph,
            });
          }
        }
      }

      if (showRegular) {
        pivots.push({
          type: "regular",
          pivotType: "high",
          price: ph,
          time: current.time,
          index: i,
          barIndex: pivotBarIndex,
        });
      }

      state.os = 1;
      state.lastPivotPrice = ph;
      state.lastPivotIndex = i;
      state.lastPivotType = "high";
      state.max = ph;
      state.min = ph;
    }

    // 检测 Pivot Low
    const pl = ta_pivotlow(candles, i, length);
    if (pl !== null) {
      const pivotBarIndex = i - length;

      if (showMissed) {
        if (state.os === 0) {
          missedPivots.push({
            type: "missed",
            pivotType: "high",
            price: state.max,
            time: candles[state.maxIndex].time,
            index: state.maxIndex,
            missedBy: "low",
          });
        }
        if (pl > state.min) {
          missedPivots.push({
            type: "missed",
            pivotType: "low",
            price: state.min,
            time: candles[state.minIndex].time,
            index: state.minIndex,
            missedBy: "low",
          });
          if (state.followMax !== state.max) {
            missedPivots.push({
              type: "missed",
              pivotType: "high",
              price: state.followMax,
              time: candles[state.followMaxIndex].time,
              index: state.followMaxIndex,
              missedBy: "low",
              followPrice: pl,
            });
          }
        }
      }

      if (showRegular) {
        pivots.push({
          type: "regular",
          pivotType: "low",
          price: pl,
          time: current.time,
          index: i,
          barIndex: pivotBarIndex,
        });
      }

      state.os = 0;
      state.lastPivotPrice = pl;
      state.lastPivotIndex = i;
      state.lastPivotType = "low";
      state.max = pl;
      state.min = pl;
    }
  }

  return { pivots, missedPivots, state };
}

function initState(
  candles: Array<{ high: number; low: number }>,
  length: number
) {
  let max = -Infinity;
  let min = Infinity;
  let maxIndex = length;
  let minIndex = length;

  // 前端是 0..=length，K 线不够时只遍历现有数据
  const upper = Math.min(length, candles.length - 1);
  for (let i = 0; i <= upper; i++) {
    if (candles[i].high > max) {
      max = candles[i].high;
      maxIndex = i;
    }
    if (candles[i].low < min) {
      min = candles[i].low;
      minIndex = i;
    }
  }

  return {
    max,
    min,
    maxIndex,
    minIndex,
    followMax: max,
    followMin: min,
    followMaxIndex: maxIndex,
    followMinIndex: minIndex,
    os: 0 as 0 | 1,
    lastPivotPrice: 0,
    lastPivotIndex: 0,
    lastPivotType: null as PivotType | null,
  };
}

function updateFollowState(
  state: ReturnType<typeof initState>,
  candles: Array<{ high: number; low: number }>,
  i: number,
  length: number
) {
  const newState = { ...state };

  const lookbackIndex = i - length;
  if (lookbackIndex >= 0 && lookbackIndex < candles.length) {
    const lookbackCandle = candles[lookbackIndex];
    if (lookbackCandle.high > newState.max) {
      newState.max = lookbackCandle.high;
      newState.maxIndex = lookbackIndex;
    }
    if (lookbackCandle.low < newState.min) {
      newState.min = lookbackCandle.low;
      newState.minIndex = lookbackIndex;
    }
  }

  if (candles[i].high > newState.followMax) {
    newState.followMax = candles[i].high;
    newState.followMaxIndex = i;
  }
  if (candles[i].low < newState.followMin) {
    newState.followMin = candles[i].low;
    newState.followMinIndex = i;
  }

  return newState;
}

function ta_pivothigh(
  candles: Array<{ high: number }>,
  i: number,
  length: number
): number | null {
  if (i < length) return null;

  const current = candles[i];
  const isHigh = current.high;

  for (let j = 1; j <= length; j++) {
    if (candles[i - j].high > isHigh) {
      return null;
    }
  }

  for (let j = 1; j < length; j++) {
    if (i + j < candles.length && candles[i + j].high >= isHigh) {
      return null;
    }
  }

  return isHigh;
}

function ta_pivotlow(
  candles: Array<{ low: number }>,
  i: number,
  length: number
): number | null {
  if (i < length) return null;

  const current = candles[i];
  const isLow = current.low;

  for (let j = 1; j <= length; j++) {
    if (candles[i - j].low < isLow) {
      return null;
    }
  }

  for (let j = 1; j < length; j++) {
    if (i + j < candles.length && candles[i + j].low <= isLow) {
      return null;
    }
  }

  return isLow;
}

/**
 * 分类 swing 为 HH/HL/LH/LL（与前端 classifyPivots 一致）
 */
export type SwingClassification = "HH" | "HL" | "LH" | "LL";

export interface ClassifiedPivot extends RegularPivot {
  classification: SwingClassification;
}

export function classifyPivots(pivots: RegularPivot[]): ClassifiedPivot[] {
  if (pivots.length < 2) {
    return pivots.map((p) => ({
      ...p,
      classification: p.pivotType === "high" ? "LH" : "LL" as SwingClassification,
    }));
  }

  const result: ClassifiedPivot[] = [];

  let lastHighPrice = 0;
  let lastLowPrice = Infinity;

  for (const pivot of pivots) {
    if (pivot.pivotType === "high") {
      if (lastHighPrice === 0) {
        result.push({ ...pivot, classification: "LH" });
      } else {
        const isHH = pivot.price > lastHighPrice;
        result.push({ ...pivot, classification: isHH ? "HH" : "LH" });
      }
      lastHighPrice = pivot.price;
    } else {
      if (lastLowPrice === Infinity) {
        result.push({ ...pivot, classification: "LL" });
      } else {
        const isHL = pivot.price > lastLowPrice;
        result.push({ ...pivot, classification: isHL ? "HL" : "LL" });
      }
      lastLowPrice = pivot.price;
    }
  }

  return result;
}
