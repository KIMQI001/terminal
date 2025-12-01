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
 * @param minSwingPercent - 两个swing point之间的最小价格变化百分比（默认0.5%）
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
