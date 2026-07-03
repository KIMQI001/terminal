/**
 * Overlap detection between ICT zones (OB / OTE / FVG)
 *
 * 用途：在 OBPanel / OTEPanel / FVGPanel 的右侧 panel 里，
 *       当同向 + 价格范围重叠的 zone 出现在视觉上时，加金色边框高亮。
 *
 * 设计原则：
 * - 同方向（bullish / bearish）：反向 zone 重叠无意义
 * - 价格区间相交（标准 overlap 定义）
 * - 跨周期规则：LTF 与 HTF 重叠时**只高亮 LTF**（HTF 太多会全亮）
 *   实现方式：item 只检查 same TF + HTF 的其他 zone，反过来不检查 LTF
 */

export type Direction = "bullish" | "bearish";

export interface PriceRange {
  high: number;
  low: number;
  type: Direction;
}

export function priceOverlaps(a: PriceRange, b: PriceRange): boolean {
  return a.high >= b.low && b.high >= a.low;
}

export function getPriceRange(item: { type: string; high?: number; low?: number; fib618?: number; fib786?: number }): PriceRange | null {
  if (item.type !== "bullish" && item.type !== "bearish") return null;

  // OB / FVG: 直接用 high / low
  if (typeof item.high === "number" && typeof item.low === "number") {
    return { high: item.high, low: item.low, type: item.type };
  }

  // OTE: 用 fib618 / fib786 作为价格边界
  if (typeof item.fib618 === "number" && typeof item.fib786 === "number") {
    return {
      high: Math.max(item.fib618, item.fib786),
      low: Math.min(item.fib618, item.fib786),
      type: item.type,
    };
  }

  return null;
}

/**
 * 周期排序（数字越大 = 越高级别 / HTF）
 * 4d 介于 4h 和 1d 之间（虽然 store 里没这个 key，但防一手）
 */
const TF_ORDER: Record<string, number> = {
  '5m': 0,
  '15m': 1,
  '1h': 2,
  '4h': 3,
  '4d': 3.5,
  '1d': 4,
  '1w': 5,
};

/** 全部可能被检查的周期（用于跨周期 LTF 单边高亮） */
export const ALL_TFS = ['5m', '15m', '1h', '4h', '1d', '1w'] as const;

/**
 * 返回 >= currentTf 排序的所有周期（包括 currentTf 自身）
 * 用法：把 item 自身的 same TF + 更高的 HTF 拿出来，逐个检查重叠
 */
export function getSameOrHigherTFs(currentTf: string, allTfs: string[]): string[] {
  const order = TF_ORDER[currentTf];
  if (order === undefined) return [currentTf];
  return allTfs.filter(t => (TF_ORDER[t] ?? -1) >= order);
}

/**
 * 判断 item 与 other1 / other2 中任意一个是否同向 + 重叠
 *
 * @deprecated 用 hasOverlapWithLists 替代（支持跨周期 LTF 单边高亮）
 */
export function hasOverlap(
  item: unknown,
  other1: unknown,
  other2: unknown
): boolean {
  return hasOverlapWithLists(item, [other1], [other2]);
}

/**
 * 判断 item 是否与 lists 中任意一个 zone 同向 + 重叠
 *
 * 跨周期规则：调用方传入的 lists 应当只包含 same TF + HTF 的 zones，
 * 这样 LTF item 会被 HTF 同向重叠高亮（符合"只高亮 LTF"原则）；
 * HTF item 不会检查 LTF，自然不会被 LTF 重叠高亮。
 *
 * 用法：
 *   const oteList = getSameOrHigherTFs(tf, ALL_TFS).map(t => mtfOTE[t]);
 *   const fvgList = getSameOrHigherTFs(tf, ALL_TFS).map(t => mtfFVG[t]);
 *   hasOverlapWithLists(ob, oteList, fvgList);
 */
export function hasOverlapWithLists(
  item: unknown,
  ...lists: ReadonlyArray<ReadonlyArray<unknown>>
): boolean {
  const itemRange = getPriceRange(item as Parameters<typeof getPriceRange>[0]);
  if (!itemRange) return false;

  for (const list of lists) {
    for (const other of list) {
      if (!other) continue;
      const otherRange = getPriceRange(other as Parameters<typeof getPriceRange>[0]);
      if (!otherRange) continue;
      if (otherRange.type !== itemRange.type) continue;
      if (priceOverlaps(itemRange, otherRange)) return true;
    }
  }

  return false;
}
