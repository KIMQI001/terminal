/**
 * Swing Points（摆动高点和低点）检测
 *
 * 底层算法已迁移到 pivotDetector.ts（基于 LuxAlgo 的实现）
 * 本文件提供向后兼容的接口
 */

import { Candle, SwingPoint as SwingPointType } from "@/types/chart";
import {
  detectPivots,
  classifyPivots as classifyPivotsNew,
  RegularPivot,
  ClassifiedPivot,
  PivotResult,
  MissedPivot,
  GhostLevel,
} from "./pivotDetector";

/**
 * 检测 Swing Points（兼容旧接口）
 * 使用 LuxAlgo 风格的算法
 *
 * @param candles - K线数据
 * @param leftBars - 左侧确认K线数量（用于分类 HH/HL/LH/LL）
 * @param rightBars - 右侧确认K线数量
 * @param minSwingPercent - 两个swing point之间的最小价格变化百分比（默认1.5%）
 * @deprecated 使用 detectAllPivots 或 detectPivotsWithMissed 代替
 */
export function detectSwingPoints(
  candles: Candle[],
  leftBars: number = 3,
  rightBars: number = 3,
  minSwingPercent: number = 1.5
): SwingPointType[] {
  // 使用新的 LuxAlgo 风格算法
  const length = leftBars + rightBars;
  const result = detectPivots(candles, length, true, false);

  // 分类并过滤
  const classified = classifyPivotsNew(result.pivots);
  const filtered = filterBySwingPercent(classified, minSwingPercent);

  return filtered.map((p) => ({
    type: p.type,
    price: p.price,
    time: p.time,
    index: p.index,
  }));
}

/**
 * 检测所有局部极值（不过滤，不过分组）
 * 使用 LuxAlgo 风格的算法
 *
 * @param candles - K线数据
 * @param leftBars - 左侧确认K线数量（默认2）
 * @param rightBars - 右侧确认K线数量（默认2）
 */
export function detectAllPivots(
  candles: Candle[],
  leftBars: number = 2,
  rightBars: number = 2
): SwingPointType[] {
  const length = leftBars + rightBars;
  const result = detectPivots(candles, length, true, false);

  return result.pivots.map((p) => ({
    type: p.pivotType,
    price: p.price,
    time: p.time,
    index: p.index,
  }));
}

/**
 * 检测带 Missed Reversal 的 Pivots（完整版）
 *
 * @param candles - K线数据
 * @param length - Pivot 回溯周期（默认50）
 */
export function detectPivotsWithMissed(
  candles: Candle[],
  length: number = 50
): {
  pivots: SwingPointType[];
  missedPivots: MissedPivot[];
  ghostLevels: GhostLevel[];
} {
  const result = detectPivots(candles, length, true, true);

  return {
    pivots: result.pivots.map((p) => ({
      type: p.pivotType,
      price: p.price,
      time: p.time,
      index: p.index,
    })),
    missedPivots: result.missedPivots,
    ghostLevels: result.ghostLevels,
  };
}

/**
 * Swing Point 分类类型（HH/HL/LH/LL）
 */
export type SwingClassification = "HH" | "HL" | "LH" | "LL";

/**
 * 带分类的 Swing Point
 */
export interface ClassifiedSwingPoint extends SwingPointType {
  classification: SwingClassification;
}

/**
 * 对 pivots 进行 HH/HL/LH/LL 分类（兼容旧接口）
 *
 * @param pivots - detectAllPivots 返回的极值点（已按时间排序）
 * @param minSwingPercent - 最小摆动幅度百分比，用于过滤无效信号
 * @deprecated 使用 detectClassifiedSwings 代替
 */
export function classifyPivots(
  pivots: SwingPointType[],
  minSwingPercent: number = 0.5
): ClassifiedSwingPoint[] {
  // 转换为新的格式
  const regularPivots: RegularPivot[] = pivots.map((p) => ({
    type: "regular",
    pivotType: p.type,
    price: p.price,
    time: p.time,
    index: p.index,
    barIndex: 0, // 旧接口不提供 barIndex
  }));

  const classified = classifyPivotsNew(regularPivots);

  return classified.map((c) => ({
    type: c.pivotType,
    price: c.price,
    time: c.time,
    index: c.index,
    classification: c.classification,
  }));
}

/**
 * 获取 HH/HL/LH/LL 分类的 Swing Points（使用新算法）
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
  const length = leftBars + rightBars;
  const result = detectPivots(candles, length, true, false);
  const classified = classifyPivotsNew(result.pivots);
  return filterBySwingPercent(classified, minSwingPercent);
}

/**
 * 按摆动幅度过滤
 */
function filterBySwingPercent(
  pivots: ClassifiedPivot[],
  minSwingPercent: number
): ClassifiedSwingPoint[] {
  const result: ClassifiedSwingPoint[] = [];
  let lastHighPrice = 0;
  let lastLowPrice = Infinity;

  for (const pivot of pivots) {
    if (pivot.pivotType === "high") {
      if (lastHighPrice === 0) {
        result.push({
          type: pivot.pivotType,
          price: pivot.price,
          time: pivot.time,
          index: pivot.index,
          classification: pivot.classification,
        });
      } else {
        const change = Math.abs(pivot.price - lastHighPrice) / lastHighPrice * 100;
        if (change >= minSwingPercent) {
          result.push({
            type: pivot.pivotType,
            price: pivot.price,
            time: pivot.time,
            index: pivot.index,
            classification: pivot.classification,
          });
        }
      }
      lastHighPrice = pivot.price;
    } else {
      if (lastLowPrice === Infinity) {
        result.push({
          type: pivot.pivotType,
          price: pivot.price,
          time: pivot.time,
          index: pivot.index,
          classification: pivot.classification,
        });
      } else {
        const change = Math.abs(pivot.price - lastLowPrice) / lastLowPrice * 100;
        if (change >= minSwingPercent) {
          result.push({
            type: pivot.pivotType,
            price: pivot.price,
            time: pivot.time,
            index: pivot.index,
            classification: pivot.classification,
          });
        }
      }
      lastLowPrice = pivot.price;
    }
  }

  return result;
}

// 重新导出类型
export type { MissedPivot, GhostLevel, PivotResult };
