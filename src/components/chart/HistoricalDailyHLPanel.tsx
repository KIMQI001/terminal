"use client";

/**
 * 历史日K极值面板
 * - 显示最近 3 根日K的 high / low
 * - 自动检测活跃 OB 是否有包裹（OB.top > day.high AND OB.btm < day.low）
 * - 命中的 HL 高亮（"高胜率"标记）
 */

import { useState, useEffect, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChartStore } from "@/stores/chartStore";
import { fetchKlines } from "@/lib/binance/api";
import { cn } from "@/lib/utils";
import type { OrderBlock } from "@/types/indicator";

interface DailyOHLC {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

interface ActiveOB {
  top: number;
  btm: number;
  type: "bullish" | "bearish";
  loc: number;
}

export function HistoricalDailyHLPanel() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [dailies, setDailies] = useState<DailyOHLC[]>([]);
  const [overlapObs, setOverlapObs] = useState<ActiveOB[]>([]);
  const { symbol, dailyKAnchors } = useChartStore();

  // 拉取最近 3 根日 K
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchKlines(symbol, "1d", 10);
        if (cancelled) return;
        const candles: DailyOHLC[] = data.map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        setDailies(candles);
      } catch {
        // 静默失败
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // 从 chartStore 拿 1D OB（最近的活跃 OB）
  // dailyKAnchors['1D'] 给当前日的 OB；要找 15m OB 需要其他来源
  // 这里简化：从 dailyKAnchors['1D'] 拿当前 OB，dailyKLineEnabled 开启时画线
  const ob15m: ActiveOB[] = useMemo(() => {
    // 简化：从 dailyKAnchors 取 1D anchor（当前最近的 OB）
    // 实际生产可以从 indicatorStore.multiTimeframeOB['15m'] 取
    const ob = dailyKAnchors['1D'];
    if (!ob) return [];
    return [
      {
        top: ob.high,
        btm: ob.low,
        type: "bullish",
        loc: ob.time,
      },
    ];
  }, [dailyKAnchors]);

  // 检测 overlap
  useEffect(() => {
    const hits: ActiveOB[] = [];
    for (const ob of ob15m) {
      for (const day of dailies) {
        // 高被包：OB.top > day.high AND OB.btm < day.high
        if (ob.top > day.high && ob.btm < day.high) {
          hits.push({ ...ob, top: day.high, btm: day.high });
          break;
        }
        // 低被包：OB.top > day.low AND OB.btm < day.low
        if (ob.top > day.low && ob.btm < day.low) {
          hits.push({ ...ob, top: day.low, btm: day.low });
          break;
        }
      }
    }
    setOverlapObs(hits);
  }, [ob15m, dailies]);

  const overlapKeys = new Set(overlapObs.map((o) => `${o.top}-${o.btm}`));

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg">
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="text-xs font-semibold text-gray-600">历史日K HL (10天)</span>
        <span className="text-gray-400 text-[10px]">{isCollapsed ? '▶' : '▼'}</span>
      </div>

      {!isCollapsed && (
        <div className="px-2 py-2 min-w-[200px]">
          <div className="grid grid-cols-4 gap-1 text-[9px] text-gray-400 font-medium pb-0.5 border-b">
            <span>日期</span>
            <span className="text-right text-red-500">High</span>
            <span className="text-right text-green-600">Low</span>
            <span className="text-right">OB 包</span>
          </div>

          {dailies.length === 0 ? (
            <div className="text-[9px] text-gray-400 py-1">加载中...</div>
          ) : (
            dailies.map((day) => {
              const hOverlapped = ob15m.some(
                (ob) => ob.top > day.high && ob.btm < day.high
              );
              const lOverlapped = ob15m.some(
                (ob) => ob.top > day.low && ob.btm < day.low
              );
              return (
                <div
                  key={day.time}
                  className="grid grid-cols-4 gap-1 text-[9px] py-0.5 items-center rounded hover:bg-gray-50"
                >
                  <span className="text-gray-600 font-mono">{formatDate(day.time)}</span>
                  <span
                    className={cn(
                      "text-right font-mono",
                      hOverlapped
                        ? "text-red-600 font-bold bg-yellow-100 px-0.5 rounded"
                        : "text-gray-700"
                    )}
                    title={hOverlapped ? "🎯 OB 包裹此高点" : ""}
                  >
                    {day.high.toFixed(1)}
                  </span>
                  <span
                    className={cn(
                      "text-right font-mono",
                      lOverlapped
                        ? "text-green-600 font-bold bg-yellow-100 px-0.5 rounded"
                        : "text-gray-700"
                    )}
                    title={lOverlapped ? "🎯 OB 包裹此低点" : ""}
                  >
                    {day.low.toFixed(1)}
                  </span>
                  <span className="text-right text-gray-500">
                    {(hOverlapped ? 1 : 0) + (lOverlapped ? 1 : 0) > 0
                      ? `✓${(hOverlapped ? 1 : 0) + (lOverlapped ? 1 : 0)}`
                      : '-'}
                  </span>
                </div>
              );
            })
          )}

          {overlapObs.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-200">
              <div className="text-[9px] text-gray-500 font-medium mb-1">
                🎯 命中 OB 详情
              </div>
              {overlapObs.map((hit, i) => (
                <div key={i} className="text-[9px] text-yellow-700 font-mono">
                  {hit.btm === hit.top ? 'H/L' : '区间'} @ {hit.btm.toFixed(1)} ({formatDate(hit.loc)})
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}