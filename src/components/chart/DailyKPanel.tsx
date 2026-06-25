"use client";

/**
 * 日K锚点面板
 * - 当前价格向左找到的第一个日K（含 4D K线参考）
 * - 显示其 OHLC + 时间
 * - 提示当前价格在日K区间的位置（百分比）
 */

import { useState, useEffect } from "react";
import { useChartStore } from "@/stores/chartStore";
import { fetchKlines } from "@/lib/binance/api";

interface AnchorCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface AnchorResult {
  candle: AnchorCandle;
  // 当前价在区间内的位置（0=low, 100=high）
  positionPercent: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 从 K 线序列中，从右向左找到第一根 currentPrice ∈ [low, high] 的K线
 */
function findAnchor(klines: AnchorCandle[], currentPrice: number): AnchorCandle | null {
  if (klines.length < 2) return null;
  // 倒数第二根开始向左扫
  for (let i = klines.length - 2; i >= 0; i--) {
    const c = klines[i];
    if (currentPrice >= c.low && currentPrice <= c.high) {
      return c;
    }
  }
  return null;
}

export function DailyKPanel() {
  const { symbol, candles } = useChartStore();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [dailyAnchor, setDailyAnchor] = useState<AnchorResult | null>(null);
  const [fourDayAnchor, setFourDayAnchor] = useState<AnchorResult | null>(null);
  const [loading, setLoading] = useState(false);

  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;

  useEffect(() => {
    if (!symbol || currentPrice <= 0) return;

    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const dailyData = await fetchKlines(symbol, "1d", 200);
        if (cancelled || dailyData.length < 2) return;

        const dCandle = findAnchor(dailyData, currentPrice);
        if (dCandle) {
          const range = dCandle.high - dCandle.low;
          const pos = range > 0
            ? Math.max(0, Math.min(100, ((currentPrice - dCandle.low) / range) * 100))
            : 0;
          setDailyAnchor({ candle: dCandle, positionPercent: pos });
        } else {
          setDailyAnchor(null);
        }

        // 4D 锚点（参考）
        try {
          const fourDData = await fetchKlines(symbol, "4d", 200);
          if (!cancelled && fourDData.length >= 2) {
            const fCandle = findAnchor(fourDData, currentPrice);
            if (fCandle) {
              const range = fCandle.high - fCandle.low;
              const pos = range > 0
                ? Math.max(0, Math.min(100, ((currentPrice - fCandle.low) / range) * 100))
                : 0;
              setFourDayAnchor({ candle: fCandle, positionPercent: pos });
            } else {
              setFourDayAnchor(null);
            }
          }
        } catch {
          setFourDayAnchor(null);
        }
      } catch (err) {
        // 静默失败
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [symbol, currentPrice]);

  const renderAnchorRow = (
    label: string,
    anchor: AnchorResult | null,
    color: string
  ) => {
    if (!anchor) {
      return (
        <div className="grid grid-cols-5 gap-1 text-[9px] py-0.5 items-center">
          <span className={`font-medium ${color}`}>{label}</span>
          <span className="col-span-4 text-gray-300">-</span>
        </div>
      );
    }
    const { candle, positionPercent } = anchor;
    return (
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[9px]">
          <span className={`font-semibold ${color}`}>{label}</span>
          <span className="text-gray-500 font-mono">{formatTime(candle.time)}</span>
        </div>
        <div className="grid grid-cols-4 gap-1 text-[10px] font-mono">
          <div className="flex flex-col">
            <span className="text-gray-400 text-[8px]">O</span>
            <span className="text-gray-700">{candle.open.toFixed(1)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-gray-400 text-[8px]">H</span>
            <span className="text-red-500">{candle.high.toFixed(1)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-gray-400 text-[8px]">L</span>
            <span className="text-green-500">{candle.low.toFixed(1)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-gray-400 text-[8px]">C</span>
            <span className="text-gray-700">{candle.close.toFixed(1)}</span>
          </div>
        </div>
        {/* 当前位置条 */}
        <div className="relative h-1.5 bg-gray-200 rounded overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-blue-400"
            style={{ width: `${positionPercent}%` }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-[8px] text-gray-700 font-mono">
            {positionPercent.toFixed(0)}%
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg w-[200px]">
      {/* 标题栏 */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="text-xs font-semibold text-gray-600">日K锚点</span>
        <span className="text-gray-400 text-[10px]">{isCollapsed ? '▶' : '▼'}</span>
      </div>

      {!isCollapsed && (
        <div className="px-2 py-2 space-y-2">
          {loading && !dailyAnchor ? (
            <div className="text-[10px] text-gray-400 text-center py-2">加载中...</div>
          ) : (
            <>
              {renderAnchorRow("1D", dailyAnchor, "text-blue-600")}
              <div className="border-t border-gray-100 pt-2">
                {renderAnchorRow("4D", fourDayAnchor, "text-purple-600")}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}