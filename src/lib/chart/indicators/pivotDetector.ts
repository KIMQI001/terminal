/**
 * LuxAlgo 风格的 Pivot Points 检测器
 *
 * 算法来源：Pivot Points High Low & Missed Reversal Levels [LuxAlgo]
 * https://www.tradingview.com/script/h0Ly0NwA-Pivot-Points-High-Low-Missed-Reversal-Levels-LuxAlgo/
 *
 * 特点：
 * 1. 追踪极值（follow_max/follow_min）
 * 2. 检测错过的反转（Missed Reversal）
 * 3. Ghost Level 虚线延伸
 */

import { Candle } from "@/types/chart";

/**
 * Pivot 类型
 */
export type PivotType = "high" | "low";

/**
 * Regular Pivot - 常规转折点
 */
export interface RegularPivot {
  type: "regular";
  pivotType: PivotType; // 'high' | 'low'
  price: number;
  time: number;
  index: number;
  barIndex: number; // pivot 相对于当前的位置
  /**
   * 该 pivot 被「右侧确认」的下标 = index + length - 1。
   * 右窗口最后一根 K 收盘后，这个 pivot 才真正成立（此前的尾部 pivot 可能随新数据消失）。
   */
  confirmIndex: number;
}

/**
 * Missed Pivot - 价格应该去但没去的点位
 */
export interface MissedPivot {
  type: "missed";
  pivotType: PivotType;
  price: number;
  time: number;
  index: number;
  missedBy: "high" | "low"; // 被什么价位错过
  followPrice?: number; // follow_max/min 的价格
}

/**
 * Ghost Level - 从 missed pivot 延伸到当前价的虚线
 */
export interface GhostLevel {
  startPrice: number;
  endPrice: number;
  startIndex: number;
  endIndex: number;
  direction: "horizontal"; // 水平延伸
  color: string;
  pivotType: PivotType;
}

/**
 * Pivot 检测结果
 */
export interface PivotResult {
  pivots: RegularPivot[];
  missedPivots: MissedPivot[];
  ghostLevels: GhostLevel[];
  // 追踪状态（用于实时更新）
  state: {
    max: number;
    min: number;
    maxIndex: number;
    minIndex: number;
    followMax: number;
    followMin: number;
    followMaxIndex: number;
    followMinIndex: number;
    os: 0 | 1; // 0 = 上次是 high, 1 = 上次是 low
    lastPivotPrice: number;
    lastPivotIndex: number;
    lastPivotType: PivotType | null;
  };
}

/**
 * 检测 Pivot Points（含 Missed Reversal）
 *
 * @param candles - K线数据
 * @param length - Pivot 回溯周期（默认50）
 * @param showRegular - 是否显示常规 pivots（默认true）
 * @param showMissed - 是否显示错过的 pivots（默认true）
 */
export function detectPivots(
  candles: Candle[],
  length: number = 50,
  showRegular: boolean = true,
  showMissed: boolean = true
): PivotResult {
  const pivots: RegularPivot[] = [];
  const missedPivots: MissedPivot[] = [];
  const ghostLevels: GhostLevel[] = [];

  if (candles.length < length + 1) {
    return {
      pivots,
      missedPivots,
      ghostLevels,
      state: initState(candles, length),
    };
  }

  // 初始化追踪状态
  let state = initState(candles, length);

  for (let i = length; i < candles.length; i++) {
    const current = candles[i];
    const n = current.time; // 使用时间戳作为 bar_index

    // 更新追踪极值
    state = updateFollowState(state, candles, i, length);

    // 检测 Pivot High
    const ph = ta_pivothigh(candles, i, length);
    if (ph !== null) {
      const pivotBarIndex = i - length;

      // 检测 Missed Pivots
      if (showMissed) {
        // 情况1: os[1] == 1 (上次是低点) -> 错过了做空机会
        if (state.os === 1) {
          // 标记错过的低点（在当前 pivot 形成前，价格应该继续下跌但没有）
          missedPivots.push({
            type: "missed",
            pivotType: "low",
            price: state.min,
            time: candles[state.minIndex].time,
            index: state.minIndex,
            missedBy: "high",
          });

          // Ghost Level: 从 missed low 画到当前 pivot
          ghostLevels.push({
            startPrice: state.min,
            endPrice: ph,
            startIndex: state.minIndex,
            endIndex: i,
            direction: "horizontal",
            color: "#ef5350",
            pivotType: "low",
          });
        }

        // 情况2: ph < max（高点低于之前追踪的最高点）-> 错过了做空机会
        if (ph < state.max) {
          // 标记错过的最高点
          missedPivots.push({
            type: "missed",
            pivotType: "high",
            price: state.max,
            time: candles[state.maxIndex].time,
            index: state.maxIndex,
            missedBy: "high",
          });

          // 标记 follow_min（价格没有继续上涨到 max，反而跌到了 follow_min）
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

            // Ghost Level: 从 missed low 画到当前 pivot
            ghostLevels.push({
              startPrice: state.followMin,
              endPrice: ph,
              startIndex: state.followMinIndex,
              endIndex: i,
              direction: "horizontal",
              color: "#26a69a",
              pivotType: "low",
            });
          }
        }
      }

      // 添加 Regular Pivot
      if (showRegular) {
        pivots.push({
          type: "regular",
          pivotType: "high",
          price: ph,
          time: current.time,
          index: i,
          barIndex: pivotBarIndex,
          // 右侧窗口 = candles[i+1 .. i+length-1]，最后一根收盘后该 pivot 才成立
          confirmIndex: i + length - 1,
        });
      }

      // 更新状态
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

      // 检测 Missed Pivots
      if (showMissed) {
        // 情况1: os[1] == 0 (上次是高点) -> 错过了做多机会
        if (state.os === 0) {
          // 标记错过的高点
          missedPivots.push({
            type: "missed",
            pivotType: "high",
            price: state.max,
            time: candles[state.maxIndex].time,
            index: state.maxIndex,
            missedBy: "low",
          });

          // Ghost Level: 从 missed high 画到当前 pivot
          ghostLevels.push({
            startPrice: state.max,
            endPrice: pl,
            startIndex: state.maxIndex,
            endIndex: i,
            direction: "horizontal",
            color: "#26a69a",
            pivotType: "high",
          });
        }

        // 情况2: pl > min（低点高于之前追踪的最低点）-> 错过了做多机会
        if (pl > state.min) {
          // 标记错过的最低点
          missedPivots.push({
            type: "missed",
            pivotType: "low",
            price: state.min,
            time: candles[state.minIndex].time,
            index: state.minIndex,
            missedBy: "low",
          });

          // 标记 follow_max（价格没有继续下跌到 min，反而涨到了 follow_max）
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

            // Ghost Level: 从 missed high 画到当前 pivot
            ghostLevels.push({
              startPrice: state.followMax,
              endPrice: pl,
              startIndex: state.followMaxIndex,
              endIndex: i,
              direction: "horizontal",
              color: "#ef5350",
              pivotType: "high",
            });
          }
        }
      }

      // 添加 Regular Pivot
      if (showRegular) {
        pivots.push({
          type: "regular",
          pivotType: "low",
          price: pl,
          time: current.time,
          index: i,
          barIndex: pivotBarIndex,
          // 右侧窗口 = candles[i+1 .. i+length-1]，最后一根收盘后该 pivot 才成立
          confirmIndex: i + length - 1,
        });
      }

      // 更新状态
      state.os = 0;
      state.lastPivotPrice = pl;
      state.lastPivotIndex = i;
      state.lastPivotType = "low";
      state.max = pl;
      state.min = pl;
    }
  }

  return { pivots, missedPivots, ghostLevels, state };
}

/**
 * 初始化追踪状态
 */
function initState(candles: Candle[], length: number) {
  let max = -Infinity;
  let min = Infinity;
  let maxIndex = length;
  let minIndex = length;

  // 初始化前 length 根 K 线的极值
  for (let i = 0; i <= length; i++) {
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

/**
 * 更新追踪极值状态
 */
function updateFollowState(
  state: ReturnType<typeof initState>,
  candles: Candle[],
  i: number,
  length: number
) {
  const newState = { ...state };

  // 更新 max/min（从 length 根 K 线前的位置开始追踪）
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

  // 更新 follow_max/min（持续追踪最高/最低价）
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

/**
 * TradingView ta.pivothigh 的实现
 * 返回 pivot high 的价格，如果当前不是 pivot 返回 null
 */
function ta_pivothigh(candles: Candle[], i: number, length: number): number | null {
  if (i < length) return null;

  const current = candles[i];
  const isHigh = current.high;

  // 左侧检查
  for (let j = 1; j <= length; j++) {
    if (candles[i - j].high > isHigh) {
      return null;
    }
  }

  // 右侧检查（到当前位置为止）
  for (let j = 1; j < length; j++) {
    if (i + j < candles.length && candles[i + j].high >= isHigh) {
      return null;
    }
  }

  return isHigh;
}

/**
 * TradingView ta.pivotlow 的实现
 * 返回 pivot low 的价格，如果当前不是 pivot 返回 null
 */
function ta_pivotlow(candles: Candle[], i: number, length: number): number | null {
  if (i < length) return null;

  const current = candles[i];
  const isLow = current.low;

  // 左侧检查
  for (let j = 1; j <= length; j++) {
    if (candles[i - j].low < isLow) {
      return null;
    }
  }

  // 右侧检查（到当前位置为止）
  for (let j = 1; j < length; j++) {
    if (i + j < candles.length && candles[i + j].low <= isLow) {
      return null;
    }
  }

  return isLow;
}

/**
 * Swing Point 分类类型（HH/HL/LH/LL）
 */
export type SwingClassification = "HH" | "HL" | "LH" | "LL";

/**
 * 摆动点的展示标签
 *
 * - 同类中的第一个（firstOfType）没有前值可比，classification 是硬编码的默认值，
 *   展示时不能拿它当结构读数 → 显示 "H" / "L"
 * - 其余按真实分类显示 "HH" / "HL" / "LH" / "LL"
 */
export type SwingLabel = SwingClassification | "H" | "L";

/**
 * 取摆动点的展示标签
 *
 * @param sp - 摆动点（需带 classification / firstOfType）
 */
export function swingLabel(sp: {
  type: "high" | "low";
  classification?: SwingClassification;
  firstOfType?: boolean;
}): SwingLabel {
  if (sp.firstOfType) return sp.type === "high" ? "H" : "L";
  if (sp.classification) return sp.classification;
  return sp.type === "high" ? "H" : "L";
}

/**
 * 带分类的 Swing Point
 */
export interface ClassifiedPivot extends RegularPivot {
  classification: SwingClassification;
  /**
   * 是否是「同类中的第一个」（高点的第一个 / 低点的第一个）。
   * 这类点没有前值可比，classification 是硬编码的默认值，展示时应显示 "H" / "L"。
   */
  firstOfType?: boolean;
}

/**
 * 对 Regular Pivots 进行 HH/HL/LH/LL 分类
 *
 * @param pivots - detectPivots 返回的 pivots 数组
 */
export function classifyPivots(pivots: RegularPivot[]): ClassifiedPivot[] {
  if (pivots.length < 2) {
    return pivots.map((p) => ({
      ...p,
      classification: p.pivotType === "high" ? "LH" : "LL" as SwingClassification,
      firstOfType: true,
    }));
  }

  const result: ClassifiedPivot[] = [];
  const highs = pivots.filter((p) => p.pivotType === "high");
  const lows = pivots.filter((p) => p.pivotType === "low");

  let lastHighPrice = 0;
  let lastLowPrice = Infinity;

  for (const pivot of pivots) {
    if (pivot.pivotType === "high") {
      if (lastHighPrice === 0) {
        result.push({ ...pivot, classification: "LH", firstOfType: true });
      } else {
        const isHH = pivot.price > lastHighPrice;
        result.push({ ...pivot, classification: isHH ? "HH" : "LH" });
      }
      lastHighPrice = pivot.price;
    } else {
      if (lastLowPrice === Infinity) {
        result.push({ ...pivot, classification: "LL", firstOfType: true });
      } else {
        const isHL = pivot.price > lastLowPrice;
        result.push({ ...pivot, classification: isHL ? "HL" : "LL" });
      }
      lastLowPrice = pivot.price;
    }
  }

  return result;
}
