import { SwingPoint } from "@/types/chart";
import { Candle } from "@/types/chart";
import { LiquidityZone } from "@/types/indicator";

/**
 * Detect Liquidity Zones
 * Equal highs/lows that form areas where stop losses are likely clustered
 */
export function detectLiquidityZones(
  candles: Candle[],
  swingPoints: SwingPoint[],
  tolerance: number = 0.001 // 0.1% tolerance for "equal" levels
): LiquidityZone[] {
  const zones: LiquidityZone[] = [];

  // Group swing highs that are at similar levels (potential sell-side liquidity)
  const swingHighs = swingPoints.filter((sp) => sp.type === "high");
  const swingLows = swingPoints.filter((sp) => sp.type === "low");

  // Find equal highs (sell-side liquidity above)
  const highGroups = groupSimilarLevels(swingHighs, tolerance);
  for (const group of highGroups) {
    if (group.length >= 2) {
      const level = group.reduce((sum, sp) => sum + sp.price, 0) / group.length;
      const times = group.map((sp) => sp.time);

      // Check if liquidity has been swept
      const maxTime = Math.max(...times);
      const swept = candles.some(
        (c) => c.time > maxTime && c.high > level * (1 + tolerance)
      );

      zones.push({
        type: "sell-side",
        level,
        strength: group.length,
        swept,
        times,
      });
    }
  }

  // Find equal lows (buy-side liquidity below)
  const lowGroups = groupSimilarLevels(swingLows, tolerance);
  for (const group of lowGroups) {
    if (group.length >= 2) {
      const level = group.reduce((sum, sp) => sum + sp.price, 0) / group.length;
      const times = group.map((sp) => sp.time);

      // Check if liquidity has been swept
      const maxTime = Math.max(...times);
      const swept = candles.some(
        (c) => c.time > maxTime && c.low < level * (1 - tolerance)
      );

      zones.push({
        type: "buy-side",
        level,
        strength: group.length,
        swept,
        times,
      });
    }
  }

  // Return only non-swept zones
  return zones.filter((z) => !z.swept);
}

function groupSimilarLevels(
  points: SwingPoint[],
  tolerance: number
): SwingPoint[][] {
  const groups: SwingPoint[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue;

    const group: SwingPoint[] = [points[i]];
    used.add(i);

    for (let j = i + 1; j < points.length; j++) {
      if (used.has(j)) continue;

      const diff = Math.abs(points[i].price - points[j].price) / points[i].price;
      if (diff <= tolerance) {
        group.push(points[j]);
        used.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}
