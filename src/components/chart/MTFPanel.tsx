"use client";

import { useState, useEffect } from "react";
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

/**
 * 当前北京时间的"总分钟数"（0-1439）
 * 用于判断某个 session 是否已经到 ready 时间
 */
function getBeijingTotalMinutes(): number {
  const now = new Date();
  const beijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return beijing.getHours() * 60 + beijing.getMinutes();
}

function isSessionReady(readyHour: number, readyMinute: number = 0): boolean {
  return getBeijingTotalMinutes() >= readyHour * 60 + readyMinute;
}

/**
 * AI session 跨 00:00 边界：22:00-05:00 北京（NY PM 跨日）
 * - 22:00-24:00: 在 22 点后
 * - 0:00-5:00:   在 5 点前
 */
function isAISessionActive(): boolean {
  const min = getBeijingTotalMinutes();
  return min >= 22 * 60 || min < 5 * 60;
}

type ActiveSession = 'AO' | 'EO' | 'AI';

/**
 * 当前北京时间应显示哪个 session 的 bias
 *  - 0:00-5:00 / 22:00-24:00 → AI (NY session)
 *  - 5:00-15:00                → AO (Asian session 前后)
 *  - 15:00-22:00               → EO (Europe session 前后)
 */
function getActiveSession(): ActiveSession {
  const min = getBeijingTotalMinutes();
  if (min < 5 * 60 || min >= 22 * 60) return 'AI';
  if (min < 15 * 60) return 'AO';
  return 'EO';
}

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
  // 每 1 分钟 re-render，让 WAIT → 实际结果 在 session ready 时立即切换
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const { multiTimeframeTrend, multiTimeframeEquilibrium, initialBalance, asiaBias, europeBias } = useIndicatorStore();

  const consensus = getConsensus(multiTimeframeTrend);

  // 整体 trend 用 consensus 决定（比简单多数更准）
  const overallTrend: TrendType = consensus.dir === 'neutral' ? 'neutral' : consensus.dir;

  // 当前 session 的 bias 决定按钮灯颜色
  const activeSession = getActiveSession();
  const activeBias: 'long' | 'short' | undefined = (() => {
    if (activeSession === 'AO') return asiaBias?.direction;
    if (activeSession === 'EO') return europeBias?.direction;
    return initialBalance?.direction;
  })();
  const activeDotColor =
    activeBias === 'long' ? 'bg-green-500' :
    activeBias === 'short' ? 'bg-red-500' :
    'bg-gray-400'; // null = WAIT

  // 按钮边框：跟随 active session 方向 + 强度
  // （active session 有数据时，按 strong/weak 染色；null 时灰）
  const activeClass = cn(
    "px-2 h-7 text-xs gap-1",
    activeBias === 'long' && "border-green-500 text-green-700",
    activeBias === 'short' && "border-red-500 text-red-700",
    !activeBias && "border-gray-300"
  );

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsExpanded(!isExpanded)}
        className={activeClass}
        title={`Current session: ${activeSession}`}
      >
        <div className={cn("w-2 h-2 rounded-full", activeDotColor)} />
        <span>MTF · {activeSession}</span>
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

          {/* Always In (IB 21-22 北京 vs Europe Zone) 行 */}
          <div className="mt-1 flex items-center gap-2 px-1">
            <span className="text-[10px] text-gray-500 font-medium">Always In</span>
            <span
              className={cn(
                "text-[10px] font-bold ml-auto",
                getAlwaysInColor(initialBalance?.direction)
              )}
            >
              {!isAISessionActive()
                ? 'WAIT'
                : initialBalance
                  ? getAlwaysInLabel(initialBalance.direction)
                  : '—'}
            </span>
          </div>
          {initialBalance && isAISessionActive() && (
            <div className="text-[9px] text-gray-400 px-1 font-mono">
              IB {Math.round(initialBalance.ibLow)}–{Math.round(initialBalance.ibHigh)} · Europe {Math.round(initialBalance.europeLow)}–{Math.round(initialBalance.europeHigh)} (EQ {Math.round(initialBalance.europeEQ)})
            </div>
          )}

          {/* Asia Open Bias (Premium/Discount 判定) 行 */}
          <div className="mt-1 flex items-center gap-2 px-1">
            <span className="text-[10px] text-gray-500 font-medium">Asia Open</span>
            <span
              className={cn(
                "text-[10px] font-bold ml-auto",
                getAsiaBiasColor(asiaBias?.direction)
              )}
            >
              {!isSessionReady(8, 15)
                ? 'WAIT'
                : asiaBias
                  ? (asiaBias.direction === 'long' ? 'ASIA LONG' : 'ASIA SHORT')
                  : '—'}
            </span>
            {asiaBias && isSessionReady(8, 15) && (
              <span
                className={cn(
                  "text-[9px] font-semibold",
                  asiaBias.inPremium ? "text-red-500" : "text-green-500"
                )}
              >
                {asiaBias.inPremium ? 'P' : 'D'}
              </span>
            )}
          </div>
          {asiaBias && isSessionReady(8, 15) && (
            <div className="text-[9px] text-gray-400 px-1 font-mono">
              AO {Math.round(asiaBias.asiaOpenLow)}–{Math.round(asiaBias.asiaOpenHigh)} · R {Math.round(asiaBias.rangeLow)}–{Math.round(asiaBias.rangeHigh)} (EQ {Math.round(asiaBias.rangeEQ)})
            </div>
          )}

          {/* Europe Open Bias (Premium/Discount 判定) 行 */}
          <div className="mt-1 flex items-center gap-2 px-1">
            <span className="text-[10px] text-gray-500 font-medium">Europe Open</span>
            <span
              className={cn(
                "text-[10px] font-bold ml-auto",
                getEuropeBiasColor(europeBias?.direction)
              )}
            >
              {!isSessionReady(16, 0)
                ? 'WAIT'
                : europeBias
                  ? (europeBias.direction === 'long' ? 'EU LONG' : 'EU SHORT')
                  : '—'}
            </span>
            {europeBias && isSessionReady(16, 0) && (
              <span
                className={cn(
                  "text-[9px] font-semibold",
                  europeBias.inPremium ? "text-red-500" : "text-green-500"
                )}
              >
                {europeBias.inPremium ? 'P' : 'D'}
              </span>
            )}
          </div>
          {europeBias && isSessionReady(16, 0) && (
            <div className="text-[9px] text-gray-400 px-1 font-mono">
              EO {Math.round(europeBias.europeOpenLow)}–{Math.round(europeBias.europeOpenHigh)} · Asia {Math.round(europeBias.asiaLow)}–{Math.round(europeBias.asiaHigh)} (EQ {Math.round(europeBias.asiaEQ)})
            </div>
          )}
        </div>
      )}
    </div>
  );
}
