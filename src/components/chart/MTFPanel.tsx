"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIndicatorStore, TrendType } from "@/stores/indicatorStore";
import { cn } from "@/lib/utils";

const TIMEFRAMES = ['1d', '4h', '1h', '15m', '5m'] as const;

export function MTFPanel() {
  const [isExpanded, setIsExpanded] = useState(false);
  const { multiTimeframeTrend } = useIndicatorStore();

  const getTrendColor = (trend: TrendType) => {
    if (trend === 'bullish') return 'bg-green-500';
    if (trend === 'bearish') return 'bg-red-500';
    return 'bg-gray-400';
  };

  const getTrendLabel = (trend: TrendType) => {
    if (trend === 'bullish') return 'BUY';
    if (trend === 'bearish') return 'SELL';
    return '-';
  };

  // 计算整体趋势（用于按钮颜色）
  const getOverallTrend = (): TrendType => {
    let bullishCount = 0;
    let bearishCount = 0;

    for (const tf of TIMEFRAMES) {
      const trend = multiTimeframeTrend[tf];
      if (trend === 'bullish') bullishCount++;
      if (trend === 'bearish') bearishCount++;
    }

    if (bullishCount > bearishCount) return 'bullish';
    if (bearishCount > bullishCount) return 'bearish';
    return 'neutral';
  };

  const overallTrend = getOverallTrend();

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "px-2 h-7 text-xs gap-1",
          overallTrend === 'bullish' && "border-green-500 text-green-600",
          overallTrend === 'bearish' && "border-red-500 text-red-600"
        )}
      >
        <div className={cn("w-2 h-2 rounded-full", getTrendColor(overallTrend))} />
        <span>MTF</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
      </Button>

      {isExpanded && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-50 min-w-[120px]">
          <div className="text-[10px] text-gray-500 font-medium mb-1 px-1">Multi-TF Trend</div>
          {TIMEFRAMES.map(tf => {
            const trend = multiTimeframeTrend[tf];
            return (
              <div key={tf} className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 rounded">
                <div className={cn("w-2.5 h-2.5 rounded-full", getTrendColor(trend))} />
                <span className="text-xs font-medium text-gray-600 w-8">{tf}</span>
                <span className={cn(
                  "text-[10px] font-semibold",
                  trend === 'bullish' && "text-green-600",
                  trend === 'bearish' && "text-red-600",
                  trend === 'neutral' && "text-gray-400"
                )}>
                  {getTrendLabel(trend)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
