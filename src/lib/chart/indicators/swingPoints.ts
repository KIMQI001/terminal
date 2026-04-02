import { Candle, SwingPoint } from "@/types/chart";

/**
 * 检测 Swing Points（摆动高点和低点）
 *
 * 使用 Pivot 方法：当前K线的 high/low 必须是左右范围内的极值
 * 对最近的K线使用动态 rightBars
 *
 * @param candles - K线数据
 * @param leftBars - 左侧确认K线数量（默认3）
 * @param rightBars - 右侧确认K线数量（默认3）
 * @param minSwingPercent - 两个swing point之间的最小价格变化百分比（默认1.5%）
 */
export function detectSwingPoints(
  candles: Candle[],
  leftBars: number = 3,
  rightBars: number = 3,
  minSwingPercent: number = 1.5
): SwingPoint[] {
  if (candles.length < leftBars + 1) return [];

  const rawSwings: SwingPoint[] = [];

  for (let i = leftBars; i < candles.length; i++) {
    const current = candles[i];

    // 动态计算实际可用的 rightBars
    const actualRightBars = Math.min(rightBars, candles.length - 1 - i);

    // 检查 Pivot High
    let isPivotHigh = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].high >= current.high) {
        isPivotHigh = false;
        break;
      }
    }
    if (isPivotHigh && actualRightBars > 0) {
      for (let j = 1; j <= actualRightBars; j++) {
        if (candles[i + j].high > current.high) {
          isPivotHigh = false;
          break;
        }
      }
    }

    if (isPivotHigh) {
      rawSwings.push({
        type: "high",
        price: current.high,
        time: current.time,
        index: i,
      });
    }

    // 检查 Pivot Low
    let isPivotLow = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].low <= current.low) {
        isPivotLow = false;
        break;
      }
    }
    if (isPivotLow && actualRightBars > 0) {
      for (let j = 1; j <= actualRightBars; j++) {
        if (candles[i + j].low < current.low) {
          isPivotLow = false;
          break;
        }
      }
    }

    if (isPivotLow) {
      rawSwings.push({
        type: "low",
        price: current.low,
        time: current.time,
        index: i,
      });
    }
  }

  rawSwings.sort((a, b) => a.time - b.time);

  if (rawSwings.length === 0) return [];

  // 构建交替结构
  const result: SwingPoint[] = [];
  let currentGroup: SwingPoint[] = [rawSwings[0]];

  for (let i = 1; i < rawSwings.length; i++) {
    const swing = rawSwings[i];
    const lastInGroup = currentGroup[currentGroup.length - 1];

    if (swing.type === lastInGroup.type) {
      currentGroup.push(swing);
    } else {
      const best = selectBestFromGroup(currentGroup);
      const lastConfirmed = result[result.length - 1];
      if (lastConfirmed) {
        const priceChange = Math.abs(best.price - lastConfirmed.price) / lastConfirmed.price * 100;
        if (priceChange >= minSwingPercent) {
          result.push(best);
        }
      } else {
        result.push(best);
      }
      currentGroup = [swing];
    }
  }

  // 处理最后一组
  if (currentGroup.length > 0) {
    const best = selectBestFromGroup(currentGroup);
    const lastConfirmed = result[result.length - 1];
    if (lastConfirmed) {
      const priceChange = Math.abs(best.price - lastConfirmed.price) / lastConfirmed.price * 100;
      if (priceChange >= minSwingPercent) {
        result.push(best);
      }
    } else {
      result.push(best);
    }
  }

  return result;
}

/**
 * 检测所有局部极值（不过滤，不过分组）
 * 用于折线图标记每个波峰波谷
 *
 * @param candles - K线数据
 * @param leftBars - 左侧确认K线数量（默认2）
 * @param rightBars - 右侧确认K线数量（默认2）
 */
export function detectAllPivots(
  candles: Candle[],
  leftBars: number = 2,
  rightBars: number = 2
): SwingPoint[] {
  if (candles.length < Math.max(leftBars, rightBars) + 1) return [];

  const results: SwingPoint[] = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const current = candles[i];

    // 动态计算实际可用的 rightBars
    const actualRightBars = Math.min(rightBars, candles.length - 1 - i);

    // 检查 Pivot High (局部高点)
    let isPivotHigh = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].high >= current.high) {
        isPivotHigh = false;
        break;
      }
    }
    if (isPivotHigh && actualRightBars > 0) {
      for (let j = 1; j <= actualRightBars; j++) {
        if (candles[i + j].high > current.high) {
          isPivotHigh = false;
          break;
        }
      }
    }

    if (isPivotHigh) {
      results.push({
        type: "high",
        price: current.high,
        time: current.time,
        index: i,
      });
    }

    // 检查 Pivot Low (局部低点)
    let isPivotLow = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].low <= current.low) {
        isPivotLow = false;
        break;
      }
    }
    if (isPivotLow && actualRightBars > 0) {
      for (let j = 1; j <= actualRightBars; j++) {
        if (candles[i + j].low < current.low) {
          isPivotLow = false;
          break;
        }
      }
    }

    if (isPivotLow) {
      results.push({
        type: "low",
        price: current.low,
        time: current.time,
        index: i,
      });
    }
  }

  // 按时间排序
  return results.sort((a, b) => a.time - b.time);
}

function selectBestFromGroup(group: SwingPoint[]): SwingPoint {
  if (group.length === 1) return group[0];

  const isHigh = group[0].type === "high";

  return group.reduce((best, current) => {
    if (isHigh) {
      return current.price > best.price ? current : best;
    } else {
      return current.price < best.price ? current : best;
    }
  });
}

/**
 * Swing Point 分类类型
 * HH = Higher High 更高的波峰
 * HL = Higher Low 更高的波谷
 * LH = Lower High 更低的波峰
 * LL = Lower Low 更低的波谷
 */
export type SwingClassification = "HH" | "HL" | "LH" | "LL";

/**
 * 带分类的 Swing Point
 */
export interface ClassifiedSwingPoint extends SwingPoint {
  classification: SwingClassification;
}

/**
 * 对 detectAllPivots 的结果进行二次规则筛选
 * 将 H/L 点分类为 HH/HL/LH/LL
 *
 * @param pivots - detectAllPivots 返回的极值点（已按时间排序）
 * @param minSwingPercent - 最小摆动幅度百分比，用于过滤无效信号
 */
export function classifyPivots(
  pivots: SwingPoint[],
  minSwingPercent: number = 0.5
): ClassifiedSwingPoint[] {
  if (pivots.length < 2) {
    return pivots.map(p => ({
      ...p,
      classification: p.type === "high" ? "LH" as SwingClassification : "LL" as SwingClassification,
    }));
  }

  // 分离高点和低点
  const highs = pivots.filter(p => p.type === "high");
  const lows = pivots.filter(p => p.type === "low");

  // 分类结果
  const classified: ClassifiedSwingPoint[] = [];

  // 追踪上一个有效的高点/低点价格
  let lastHighPrice: number | null = null;
  let lastLowPrice: number | null = null;

  // 追踪上一个点的类型和分类
  let lastPointType: "high" | "low" | null = null;
  let lastClassification: SwingClassification | null = null;

  for (const pivot of pivots) {
    let classification: SwingClassification;

    if (pivot.type === "high") {
      // 处理高点
      if (lastHighPrice === null) {
        // 第一个高点
        classification = "LH";
      } else {
        const priceChange = Math.abs(pivot.price - lastHighPrice) / lastHighPrice * 100;
        if (priceChange < minSwingPercent) {
          // 幅度太小，标记为与上一个相同类型
          classification = lastClassification === "HH" ? "HH" : "LH";
        } else if (pivot.price > lastHighPrice) {
          classification = "HH";
        } else {
          classification = "LH";
        }
      }
      lastHighPrice = pivot.price;
    } else {
      // 处理低点
      if (lastLowPrice === null) {
        // 第一个低点
        classification = "LL";
      } else {
        const priceChange = Math.abs(pivot.price - lastLowPrice) / lastLowPrice * 100;
        if (priceChange < minSwingPercent) {
          // 幅度太小，标记为与上一个相同类型
          classification = lastClassification === "HL" ? "HL" : "LL";
        } else if (pivot.price > lastLowPrice) {
          classification = "HL";
        } else {
          classification = "LL";
        }
      }
      lastLowPrice = pivot.price;
    }

    lastPointType = pivot.type;
    lastClassification = classification;

    classified.push({
      ...pivot,
      classification,
    });
  }

  return classified;
}

/**
 * 获取 HH/HL/LH/LL 分类的 Swing Points
 *
 * @param candles - K线数据
 * @param leftBars - 左侧确认K线数量
 * @param rightBars - 右侧确认K线数量
 * @param minSwingPercent - 最小摆动幅度百分比
 */
export function detectClassifiedSwings(
  candles: Candle[],
  leftBars: number = 2,
  rightBars: number = 2,
  minSwingPercent: number = 0.5
): ClassifiedSwingPoint[] {
  const pivots = detectAllPivots(candles, leftBars, rightBars);
  return classifyPivots(pivots, minSwingPercent);
}
