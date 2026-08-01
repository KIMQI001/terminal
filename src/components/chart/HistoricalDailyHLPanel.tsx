"use client";

/**
 * 历史日K面板
 * - 显示最近 10 根日K的 O/H/L/C
 * - 点击 O/H/L/C 任一价格 → 预填下单（SL ± 200, TP ± 1000）
 * - 纯信息面板，无 OB 检测
 */

import { useState, useEffect } from "react";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore, OTEPrefillData, TradingLine } from "@/stores/orderStore";
import { fetchKlines } from "@/lib/binance/api";

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

type KeyType = "O" | "H" | "L" | "C";
type SortDir = "asc" | "desc";

export function HistoricalDailyHLPanel() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [dailies, setDailies] = useState<DailyOHLC[]>([]);
  const [sortKey, setSortKey] = useState<KeyType | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const { symbol, candles } = useChartStore();
  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const { setPrefillData, setTradingLines, openModal } = useOrderStore();

  // 点击列头排序：同列再点切方向，换列重置为 asc
  const handleHeaderClick = (key: KeyType) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // 排序后的列表（无排序时保持原顺序 = 按 time 倒序）
  const sortedDailies = (() => {
    if (!sortKey) return dailies;
    const sorted = [...dailies].sort((a, b) => {
      const va = a[sortKey as keyof DailyOHLC] as number;
      const vb = b[sortKey as keyof DailyOHLC] as number;
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return sorted;
  })();

  // 拉取最近 10 根日 K
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchKlines(symbol, "1d", 10);
        if (cancelled) return;
        setDailies(
          data.map((c) => ({
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }))
        );
      } catch {
        // 静默失败
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // 点击 O/H/L/C → 预填下单
  // 方向判定：点击价 > 当前价 → 做空（在阻力位挂单等回踩）
  //         点击价 < 当前价 → 做多（在支撑位挂单等反弹）
  const handlePriceClick = (key: KeyType, price: number) => {
    if (currentPrice <= 0) return;
    const side: "buy" | "sell" = price > currentPrice ? "sell" : "buy";
    const slOffset = side === "buy" ? -200 : 200;
    const tpOffset = side === "buy" ? 1000 : -1000;
    void key;  // 仅用于语义（hover tooltip），不再决定方向
    const prefillData: OTEPrefillData = {
      side,
      entry: price,
      stopLoss: price + slOffset,
      takeProfit: price + tpOffset,
    };
    const lines: TradingLine[] = [
      { price: prefillData.entry, type: "entry", side },
      { price: prefillData.stopLoss, type: "stopLoss", side },
      { price: prefillData.takeProfit, type: "takeProfit", side },
    ];
    setTradingLines(lines);
    setPrefillData({ ...prefillData, side });
    openModal();
  };

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg">
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="text-xs font-semibold text-gray-600">历史日K OHLC (10天)</span>
        <span className="text-gray-400 text-[10px]">{isCollapsed ? '▶' : '▼'}</span>
      </div>

      {!isCollapsed && (
        <div className="px-2 py-2 min-w-[200px]">
          <div className="grid grid-cols-5 gap-1 text-[9px] text-gray-400 font-medium pb-0.5 border-b">
            <span>日期</span>
            {(["O", "H", "L", "C"] as KeyType[]).map((key) => (
              <span
                key={key}
                onClick={() => handleHeaderClick(key)}
                className={`text-right cursor-pointer select-none hover:text-gray-700 ${
                  sortKey === key ? "text-gray-700 font-semibold" : ""
                } ${key === "H" ? "text-red-500" : ""} ${key === "L" ? "text-green-600" : ""}`}
                title={`点击排序 ${key}`}
              >
                {key}
                {sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
              </span>
            ))}
          </div>

          {sortedDailies.length === 0 ? (
            <div className="text-[9px] text-gray-400 py-1">加载中...</div>
          ) : (
            sortedDailies.map((day) => (
              <div
                key={day.time}
                className="grid grid-cols-5 gap-1 text-[9px] py-0.5 items-center rounded hover:bg-gray-50"
              >
                <span className="text-gray-600 font-mono">{formatDate(day.time)}</span>
                <span
                  className="text-right font-mono cursor-pointer hover:bg-blue-50 hover:underline text-gray-700"
                  title="点击 O 价位做多"
                  onClick={() => handlePriceClick("O", day.open)}
                >
                  {day.open.toFixed(1)}
                </span>
                <span
                  className="text-right font-mono cursor-pointer hover:bg-red-50 hover:underline text-red-600"
                  title="点击 H 价位做空（阻力）"
                  onClick={() => handlePriceClick("H", day.high)}
                >
                  {day.high.toFixed(1)}
                </span>
                <span
                  className="text-right font-mono cursor-pointer hover:bg-green-50 hover:underline text-green-600"
                  title="点击 L 价位做多（支撑）"
                  onClick={() => handlePriceClick("L", day.low)}
                >
                  {day.low.toFixed(1)}
                </span>
                <span
                  className="text-right font-mono cursor-pointer hover:bg-orange-50 hover:underline text-gray-700"
                  title="点击 C 价位做空（收盘压制）"
                  onClick={() => handlePriceClick("C", day.close)}
                >
                  {day.close.toFixed(1)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}