"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useIndicatorStore,
  TrendType,
  MultiTimeframeEquilibriumEntry,
} from "@/stores/indicatorStore";
import { ZoneSide } from "@/lib/chart/indicators/equilibrium";
import { AlwaysInDirection } from "@/lib/chart/indicators/initialBalance";
import { AsiaBiasDirection } from "@/lib/chart/indicators/asiaBias";
import { EuropeBiasDirection } from "@/lib/chart/indicators/europeBias";
import { cn } from "@/lib/utils";

const TIMEFRAMES = ['1d', '4h', '1h', '15m', '5m'] as const;

type Consensus = {
  label: string;
  strength: 'strong' | 'weak' | 'none';
  dir: TrendType;
};

function getConsensus(trend: Record<typeof TIMEFRAMES[number], TrendType>): Consensus {
  let bullish = 0;
  let bearish = 0;
  for (const tf of TIMEFRAMES) {
    if (trend[tf] === 'bullish') bullish++;
    else if (trend[tf] === 'bearish') bearish++;
  }
  if (bullish >= 3) return { label: 'STRONG BUY', strength: 'strong', dir: 'bullish' };
  if (bearish >= 3) return { label: 'STRONG SELL', strength: 'strong', dir: 'bearish' };
  if (bullish >= 2) return { label: 'WEAK BUY', strength: 'weak', dir: 'bullish' };
  if (bearish >= 2) return { label: 'WEAK SELL', strength: 'weak', dir: 'bearish' };
  return { label: 'MIXED', strength: 'none', dir: 'neutral' };
}

function getTrendColor(trend: TrendType) {
  if (trend === 'bullish') return 'bg-green-500';
  if (trend === 'bearish') return 'bg-red-500';
  return 'bg-gray-400';
}

function getTrendLabel(trend: TrendType) {
  if (trend === 'bullish') return 'BUY';
  if (trend === 'bearish') return 'SELL';
  return '-';
}

function getSideColor(side: ZoneSide) {
  if (side === 'premium') return 'text-red-500';
  if (side === 'discount') return 'text-green-500';
  return 'text-gray-400';
}

function getSideMark(side: ZoneSide) {
  if (side === 'premium') return 'P';
  if (side === 'discount') return 'D';
  return '=';
}

function getAlwaysInLabel(dir: AlwaysInDirection | undefined) {
  if (dir === 'long') return 'ALWAYS IN LONG';
  if (dir === 'short') return 'ALWAYS IN SHORT';
  return 'WAIT';
}

function getAlwaysInColor(dir: AlwaysInDirection | undefined) {
  if (dir === 'long') return 'text-green-700';
  if (dir === 'short') return 'text-red-700';
  return 'text-gray-500';
}

function getAsiaBiasColor(dir: AsiaBiasDirection | undefined) {
  if (dir === 'long') return 'text-green-700';
  if (dir === 'short') return 'text-red-700';
  return 'text-gray-500';
}

function getEuropeBiasColor(dir: EuropeBiasDirection | undefined) {
  if (dir === 'long') return 'text-green-700';
  if (dir === 'short') return 'text-red-700';
  return 'text-gray-500';
}

export function MTFPanel() {
  const [isExpanded, setIsExpanded] = useState(false);
  const { multiTimeframeTrend, multiTimeframeEquilibrium, initialBalance, asiaBias, europeBias } = useIndicatorStore();

  const consensus = getConsensus(multiTimeframeTrend);

  // 整体 trend 用 consensus 决定（比简单多数更准）
  const overallTrend: TrendType = consensus.dir === 'neutral' ? 'neutral' : consensus.dir;

  const consensusButtonClass = cn(
    "px-2 h-7 text-xs gap-1",
    consensus.strength === 'strong' && consensus.dir === 'bullish' && "border-green-600 text-green-700 font-bold",
    consensus.strength === 'strong' && consensus.dir === 'bearish' && "border-red-600 text-red-700 font-bold",
    consensus.strength === 'weak' && consensus.dir === 'bullish' && "border-green-400 text-green-500",
    consensus.strength === 'weak' && consensus.dir === 'bearish' && "border-red-400 text-red-500"
  );

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsExpanded(!isExpanded)}
        className={consensusButtonClass}
      >
        <div className={cn("w-2 h-2 rounded-full", getTrendColor(overallTrend))} />
        <span>MTF</span>
        <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
      </Button>

      {isExpanded && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-50 min-w-[200px]">
          <div className="text-[10px] text-gray-500 font-medium mb-1 px-1">Multi-TF Trend + EQ</div>

          {TIMEFRAMES.map((tf) => {
            const trend = multiTimeframeTrend[tf];
            const eq: MultiTimeframeEquilibriumEntry | null =
              multiTimeframeEquilibrium[tf];

            return (
              <div
                key={tf}
                className="flex items-center gap-2 py-1 px-1 hover:bg-gray-50 rounded"
              >
                <div className={cn("w-2.5 h-2.5 rounded-full", getTrendColor(trend))} />
                <span className="text-xs font-medium text-gray-600 w-8">{tf}</span>
                <span
                  className={cn(
                    "text-[10px] font-semibold w-8",
                    trend === 'bullish' && "text-green-600",
                    trend === 'bearish' && "text-red-600",
                    trend === 'neutral' && "text-gray-400"
                  )}
                >
                  {getTrendLabel(trend)}
                </span>

                {eq ? (
                  <>
                    <span className="text-[10px] text-gray-500 ml-auto font-mono">
                      EQ {Math.round(eq.equilibrium)}
                    </span>
                    <span
                      className={cn(
                        "text-[10px] font-bold w-4 text-center",
                        getSideColor(eq.side)
                      )}
                    >
                      {getSideMark(eq.side)}
                    </span>
                  </>
                ) : (
                  <span className="text-[10px] text-gray-300 ml-auto">—</span>
                )}
              </div>
            );
          })}

          {/* HTF Consensus 行 */}
          <div className="mt-2 pt-2 border-t border-gray-200 flex items-center gap-2 px-1">
            <span className="text-[10px] text-gray-500 font-medium">Consensus</span>
            <span
              className={cn(
                "text-[10px] font-bold ml-auto",
                consensus.dir === 'bullish' && consensus.strength === 'strong' && "text-green-700",
                consensus.dir === 'bullish' && consensus.strength === 'weak' && "text-green-500",
                consensus.dir === 'bearish' && consensus.strength === 'strong' && "text-red-700",
                consensus.dir === 'bearish' && consensus.strength === 'weak' && "text-red-500",
                consensus.strength === 'none' && "text-gray-400"
              )}
            >
              {consensus.label}
            </span>
          </div>

          {/* Always In (IB 21-22 北京 vs PDH/PDL) 行 */}
          <div className="mt-1 flex items-center gap-2 px-1">
            <span className="text-[10px] text-gray-500 font-medium">Always In</span>
            <span
              className={cn(
                "text-[10px] font-bold ml-auto",
                getAlwaysInColor(initialBalance?.direction)
              )}
            >
              {initialBalance ? getAlwaysInLabel(initialBalance.direction) : '—'}
            </span>
          </div>
          {initialBalance && (
            <div className="text-[9px] text-gray-400 px-1 font-mono">
              IB {Math.round(initialBalance.ibLow)}–{Math.round(initialBalance.ibHigh)} · PD {Math.round(initialBalance.pdl)}–{Math.round(initialBalance.pdh)}
            </div>
          )}

          {/* Asia Open Window Bias (7:30-8:00 北京 vs 当日 0-7:30 H/L) 行 */}
          <div className="mt-1 flex items-center gap-2 px-1">
            <span className="text-[10px] text-gray-500 font-medium">Asia Open</span>
            <span
              className={cn(
                "text-[10px] font-bold ml-auto",
                getAsiaBiasColor(asiaBias?.direction)
              )}
            >
              {asiaBias
                ? (asiaBias.direction === 'long' ? 'ASIA LONG' : 'ASIA SHORT')
                : '—'}
            </span>
          </div>
          {asiaBias && (
            <div className="text-[9px] text-gray-400 px-1 font-mono">
              AO {Math.round(asiaBias.asiaOpenLow)}–{Math.round(asiaBias.asiaOpenHigh)} · prev {Math.round(asiaBias.prevTodayLow)}–{Math.round(asiaBias.prevTodayHigh)}
            </div>
          )}

          {/* Europe Open Judas (15:30-16:00 北京, 反向) 行 */}
          <div className="mt-1 flex items-center gap-2 px-1">
            <span className="text-[10px] text-gray-500 font-medium">EU Judas</span>
            <span
              className={cn(
                "text-[10px] font-bold ml-auto",
                getEuropeBiasColor(europeBias?.direction)
              )}
            >
              {europeBias
                ? (europeBias.direction === 'long' ? 'EU LONG' : 'EU SHORT')
                : '—'}
            </span>
            {europeBias && europeBias.judasFlipped && (
              <span className="text-[9px] text-amber-600 font-semibold">↺FLIP</span>
            )}
          </div>
          {europeBias && (
            <div className="text-[9px] text-gray-400 px-1 font-mono">
              EO {Math.round(europeBias.europeOpenLow)}–{Math.round(europeBias.europeOpenHigh)} · prev {Math.round(europeBias.prevTodayLow)}–{Math.round(europeBias.prevTodayHigh)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
