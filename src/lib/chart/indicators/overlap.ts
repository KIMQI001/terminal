/**
 * Overlap detection between ICT zones (OB / OTE / FVG)
 *
 * 用途：在 OBPanel / OTEPanel / FVGPanel 的右侧 panel 里，
 *       当同向 + 同周期 + 价格范围重叠的两个 zone 在视觉上同时出现时，
 *       加金色边框高亮。
 *
 * 设计原则：
 * - 同方向（bullish / bearish）：反向 zone 重叠无意义
 * - 同周期（multi-TF 行）或当前周期（zone 卡片）
 * - 价格区间相交（标准 overlap 定义）
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
 * 判断 item 与 other1 / other2 中任意一个是否同向 + 重叠
 *
 * 用于 panel 渲染时：拿到当前 zone 后，传入其他两种 indicator 在同周期的对象，
 * 返回是否应该金色高亮。
 */
export function hasOverlap(
  item: unknown,
  other1: unknown,
  other2: unknown
): boolean {
  const itemRange = getPriceRange(item as Parameters<typeof getPriceRange>[0]);
  if (!itemRange) return false;

  for (const other of [other1, other2]) {
    if (!other) continue;
    const otherRange = getPriceRange(other as Parameters<typeof getPriceRange>[0]);
    if (!otherRange) continue;
    if (otherRange.type !== itemRange.type) continue;
    if (priceOverlaps(itemRange, otherRange)) return true;
  }

  return false;
}
