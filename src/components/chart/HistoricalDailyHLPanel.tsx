"use client";

/**
 * 历史日K极值面板
 * - 显示最近 10 根日K的 high / low
 * - 自动检测 15m OB 是否包裹（OB.top > day.high AND OB.btm < day.low）
 * - 命中的 HL 高亮（"高胜率"标记）
 * - 点击 HL 价格 → 预填下单（entry=HL, SL=HL±200）
 */

import { useState, useEffect, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChartStore } from "@/stores/chartStore";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useOrderStore, OTEPrefillData, TradingLine } from "@/stores/orderStore";
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
  const { multiTimeframeOB, orderBlocks } = useIndicatorStore();
  const { setPrefillData, setTradingLines, openModal } = useOrderStore();

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

  // 从 indicatorStore 取当前周期所有 OBs（OBPanel Zones 列表同源）
// 当前用户的图表周期就是 OBPanel 显示的周期（推荐 15m）
  const ob15m: ActiveOB[] = useMemo(() => {
    return orderBlocks
      .filter((b) => b.startTime && b.high && b.low)
      .map((b) => ({
        top: b.high,
        btm: b.low,
        type: b.type,
        loc: b.startTime,
      }));
  }, [orderBlocks]);

  // 点击 HL 价格 → 预填下单
  const handleHlClick = (hlType: 'H' | 'L', price: number) => {
    // H 价位做空（挂上面等回踩），L 价位做多（挂下面等反弹）
    const side = hlType === 'H' ? 'sell' : 'buy';
    const slOffset = hlType === 'H' ? 200 : -200;
    const tpOffset = hlType === 'H' ? -1000 : 1000;
    const prefillData: OTEPrefillData = {
      side,
      entry: price,
      stopLoss: price + slOffset,
      takeProfit: price + tpOffset,
    };
    const lines: TradingLine[] = [
      { price: prefillData.entry, type: 'entry', side },
      { price: prefillData.stopLoss, type: 'stopLoss', side },
      { price: prefillData.takeProfit, type: 'takeProfit', side },
    ];
    setTradingLines(lines);
    setPrefillData(prefillData);
    openModal();
  };

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
                      "text-right font-mono cursor-pointer hover:underline",
                      hOverlapped
                        ? "text-red-600 font-bold bg-yellow-100 px-0.5 rounded"
                        : "text-gray-700 hover:bg-red-50"
                    )}
                    title={hOverlapped ? "🎯 OB 包裹此高点，点击做空" : "点击做空 (H 价位)"}
                    onClick={() => handleHlClick('H', day.high)}
                  >
                    {day.high.toFixed(1)}
                  </span>
                  <span
                    className={cn(
                      "text-right font-mono cursor-pointer hover:underline",
                      lOverlapped
                        ? "text-green-600 font-bold bg-yellow-100 px-0.5 rounded"
                        : "text-gray-700 hover:bg-green-50"
                    )}
                    title={lOverlapped ? "🎯 OB 包裹此低点，点击做多" : "点击做多 (L 价位)"}
                    onClick={() => handleHlClick('L', day.low)}
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