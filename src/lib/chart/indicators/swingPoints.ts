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
 * 检测 Swing Points（默认使用 LuxAlgo 风格 length=50）
 * 使用 LuxAlgo 风格的算法，包含 Missed Reversal 检测
 *
 * @param candles - K线数据
 * @param length - Pivot 回溯周期（默认50，与 LuxAlgo 一致）
 * @deprecated 使用 detectPivotsFull 代替
 */
export function detectSwingPoints(
  candles: Candle[],
  length: number = 50
): SwingPointType[] {
  const result = detectPivots(candles, length, true, true);

  return result.pivots.map((p) => ({
    type: p.pivotType,
    price: p.price,
    time: p.time,
    index: p.index,
  }));
}

/**
 * 完整版 Pivot 检测（LuxAlgo 风格）
 * 返回 regular pivots + missed pivots + ghost levels
 *
 * @param candles - K线数据
 * @param length - Pivot 回溯周期（默认50）
 */
export function detectPivotsFull(
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
 * 「长波段」判定阈值：相邻两个摆动点(HH↔LL)的价格差 > 1500 点算长 leg
 */
export const LONG_LEG_MIN_POINTS = 1500;

/** 长 leg 的 HH 端点颜色（蓝） */
export const LONG_LEG_HH_COLOR = "#3b82f6";
/** 长 leg 的 LL 端点颜色（橙） */
export const LONG_LEG_LL_COLOR = "#f97316";

/**
 * 找出所有属于「长 leg」的摆动点 index
 *
 * leg = 相邻两个摆动点之间的一段行情（高 ↔ 低），
 * 长度 = |priceA - priceB|（价格点）。超过阈值的 leg，其两端点会被特殊配色：
 * HH(高点) 用蓝色、LL(低点) 用橙色。
 *
 * @param points - 摆动点（需按时间/下标升序）
 * @param minPoints - 长 leg 阈值（价格点），默认 1500
 * @returns 属于长 leg 的摆动点 index 集合
 */
export function findLongLegSwingIndices(
  points: Array<{ type: "high" | "low"; price: number; index: number }>,
  minPoints: number = LONG_LEG_MIN_POINTS
): Set<number> {
  const longLeg = new Set<number>();
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (Math.abs(a.price - b.price) > minPoints) {
      longLeg.add(a.index);
      longLeg.add(b.index);
    }
  }
  return longLeg;
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
