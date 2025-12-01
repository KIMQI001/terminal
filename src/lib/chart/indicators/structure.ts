import { SwingPoint } from "@/types/chart";
import { BOS, CHoCH } from "@/types/indicator";

/**
 * Detect Break of Structure (BOS) and Change of Character (CHoCH)
 * BOS: Price breaks a swing high/low in the direction of the trend
 * CHoCH: Price breaks a swing high/low against the trend (reversal signal)
 */
export function detectStructure(
  swingPoints: SwingPoint[],
  currentPrice: number
): { bos: BOS[]; choch: CHoCH[] } {
  const bosSignals: BOS[] = [];
  const chochSignals: CHoCH[] = [];

  if (swingPoints.length < 4) {
    return { bos: bosSignals, choch: chochSignals };
  }

  // Determine trend based on recent swing points
  let currentTrend: "up" | "down" = "up";
  const recentHighs = swingPoints.filter((sp) => sp.type === "high").slice(-3);
  const recentLows = swingPoints.filter((sp) => sp.type === "low").slice(-3);

  if (recentHighs.length >= 2 && recentLows.length >= 2) {
    const highsTrend = recentHighs[recentHighs.length - 1].price > recentHighs[0].price;
    const lowsTrend = recentLows[recentLows.length - 1].price > recentLows[0].price;

    currentTrend = highsTrend && lowsTrend ? "up" : "down";
  }

  // Look for structure breaks
  for (let i = 1; i < swingPoints.length; i++) {
    const prevPoint = swingPoints[i - 1];
    const currPoint = swingPoints[i];

    // Find same type previous swing point
    const sameTypePrev = swingPoints
      .slice(0, i)
      .filter((sp) => sp.type === currPoint.type)
      .pop();

    if (!sameTypePrev) continue;

    // Check if current swing breaks previous same-type swing
    if (currPoint.type === "high") {
      // Break above previous swing high
      if (currPoint.price > sameTypePrev.price) {
        if (currentTrend === "up") {
          // BOS in uptrend
          bosSignals.push({
            type: "bullish",
            level: sameTypePrev.price,
            time: currPoint.time,
            swingPoint: sameTypePrev,
          });
        } else {
          // CHoCH - bullish reversal
          chochSignals.push({
            type: "bullish",
            level: sameTypePrev.price,
            time: currPoint.time,
            previousTrend: "down",
          });
        }
      }
    } else {
      // Break below previous swing low
      if (currPoint.price < sameTypePrev.price) {
        if (currentTrend === "down") {
          // BOS in downtrend
          bosSignals.push({
            type: "bearish",
            level: sameTypePrev.price,
            time: currPoint.time,
            swingPoint: sameTypePrev,
          });
        } else {
          // CHoCH - bearish reversal
          chochSignals.push({
            type: "bearish",
            level: sameTypePrev.price,
            time: currPoint.time,
            previousTrend: "up",
          });
        }
      }
    }
  }

  return {
    bos: bosSignals.slice(-5),
    choch: chochSignals.slice(-3),
  };
}
