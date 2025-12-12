"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChartStore } from "@/stores/chartStore";
import { cn } from "@/lib/utils";

type ZoneType = 'P' | 'M' | 'D';

export function DailyHLPanel() {
  const [isExpanded, setIsExpanded] = useState(false);
  const { dailyHL, candles, symbol } = useChartStore();

  if (!dailyHL) return null;

  const range = dailyHL.high - dailyHL.low;
  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const quarterRange = range / 4;

  // 判断当前区域
  let zone: ZoneType = 'M';
  if (currentPrice >= dailyHL.high - quarterRange) {
    zone = 'P';
  } else if (currentPrice <= dailyHL.low + quarterRange) {
    zone = 'D';
  }

  const pStart = dailyHL.high - quarterRange;
  const dStart = dailyHL.low + quarterRange;
  const decimals = symbol.includes('BTC') ? 1 : 2;

  const getZoneColor = (z: ZoneType) => {
    if (z === 'P') return 'bg-red-500';
    if (z === 'D') return 'bg-green-500';
    return 'bg-blue-500';
  };

  const getZoneTextColor = (z: ZoneType) => {
    if (z === 'P') return 'text-red-600';
    if (z === 'D') return 'text-green-600';
    return 'text-blue-600';
  };

  const getZoneBorderColor = (z: ZoneType) => {
    if (z === 'P') return 'border-red-500';
    if (z === 'D') return 'border-green-500';
    return 'border-blue-500';
  };

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "px-2 h-7 text-xs gap-1",
          getZoneBorderColor(zone),
          getZoneTextColor(zone)
        )}
      >
        <div className={cn("w-2 h-2 rounded-full", getZoneColor(zone))} />
        <span>{zone}</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
      </Button>

      {isExpanded && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-50 min-w-[160px]">
          <div className="text-[10px] text-gray-500 font-medium mb-1 px-1">Daily Range</div>

          <div className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 rounded">
            <span className="text-xs text-gray-500 w-8">H</span>
            <span className="text-xs font-mono text-gray-700">{dailyHL.high.toFixed(decimals)}</span>
          </div>

          <div className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 rounded">
            <span className="text-xs text-red-500 w-8">P</span>
            <span className="text-xs font-mono text-gray-700">{pStart.toFixed(decimals)}</span>
          </div>

          <div className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 rounded">
            <span className="text-xs text-green-500 w-8">D</span>
            <span className="text-xs font-mono text-gray-700">{dStart.toFixed(decimals)}</span>
          </div>

          <div className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 rounded">
            <span className="text-xs text-gray-500 w-8">L</span>
            <span className="text-xs font-mono text-gray-700">{dailyHL.low.toFixed(decimals)}</span>
          </div>

          <div className="border-t border-gray-100 mt-1 pt-1">
            <div className="flex items-center gap-2 py-1 px-1">
              <span className="text-xs text-gray-500 w-8">R</span>
              <span className="text-xs font-mono text-gray-700">{(range / dailyHL.low * 100).toFixed(2)}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
