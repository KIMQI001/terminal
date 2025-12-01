import { Killzone } from "@/types/indicator";

/**
 * ICT Killzones - Key trading sessions
 * These are the times when institutional order flow is highest
 */
export const KILLZONES: Killzone[] = [
  {
    name: "asian",
    startHour: 20, // 20:00 UTC (previous day)
    endHour: 0,    // 00:00 UTC
    color: "rgba(156, 163, 175, 0.1)", // Gray
  },
  {
    name: "london",
    startHour: 2,  // 02:00 UTC
    endHour: 5,    // 05:00 UTC
    color: "rgba(59, 130, 246, 0.1)", // Blue
  },
  {
    name: "ny-am",
    startHour: 12, // 12:00 UTC (7:00 AM EST)
    endHour: 15,   // 15:00 UTC (10:00 AM EST)
    color: "rgba(34, 197, 94, 0.1)", // Green
  },
  {
    name: "ny-pm",
    startHour: 18, // 18:00 UTC (1:00 PM EST)
    endHour: 21,   // 21:00 UTC (4:00 PM EST)
    color: "rgba(239, 68, 68, 0.1)", // Red
  },
];

/**
 * Check if a given timestamp falls within a killzone
 */
export function isInKillzone(timestamp: number): Killzone | null {
  const date = new Date(timestamp * 1000);
  const hour = date.getUTCHours();

  for (const kz of KILLZONES) {
    if (kz.startHour > kz.endHour) {
      // Crosses midnight (e.g., Asian session)
      if (hour >= kz.startHour || hour < kz.endHour) {
        return kz;
      }
    } else {
      if (hour >= kz.startHour && hour < kz.endHour) {
        return kz;
      }
    }
  }

  return null;
}

/**
 * Get killzone ranges for a given time period
 */
export function getKillzoneRanges(
  startTime: number,
  endTime: number
): { killzone: Killzone; start: number; end: number }[] {
  const ranges: { killzone: Killzone; start: number; end: number }[] = [];
  const oneDay = 24 * 60 * 60;

  // Iterate through each day in the range
  let currentDay = Math.floor(startTime / oneDay) * oneDay;

  while (currentDay <= endTime) {
    for (const kz of KILLZONES) {
      let kzStart: number;
      let kzEnd: number;

      if (kz.startHour > kz.endHour) {
        // Crosses midnight
        kzStart = currentDay + kz.startHour * 3600;
        kzEnd = currentDay + oneDay + kz.endHour * 3600;
      } else {
        kzStart = currentDay + kz.startHour * 3600;
        kzEnd = currentDay + kz.endHour * 3600;
      }

      // Only include if it overlaps with our time range
      if (kzEnd > startTime && kzStart < endTime) {
        ranges.push({
          killzone: kz,
          start: Math.max(kzStart, startTime),
          end: Math.min(kzEnd, endTime),
        });
      }
    }

    currentDay += oneDay;
  }

  return ranges;
}
