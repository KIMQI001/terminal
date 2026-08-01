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

export function HistoricalDailyHLPanel() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [dailies, setDailies] = useState<DailyOHLC[]>([]);
  const { symbol } = useChartStore();
  const { setPrefillData, setTradingLines, openModal } = useOrderStore();

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
  // H/C 价位 → 做空（反向阻力）；O/L 价位 → 做多（反向支撑）
  // O 和 C 同向：O 做多（开盘价作为入场）、C 做空（收盘价作为入场）
  // H 价位 → 做空（阻力）；L 价位 → 做多（支撑）
  const handlePriceClick = (key: KeyType, price: number) => {
    let side: "buy" | "sell";
    let slOffset: number;
    let tpOffset: number;
    let label: string;
    if (key === "H") {
      // H 价位做空（阻力位挂空）
      side = "sell";
      slOffset = 200;
      tpOffset = -1000;
      label = "H 阻力做空";
    } else if (key === "L") {
      // L 价位做多（支撑位挂多）
      side = "buy";
      slOffset = -200;
      tpOffset = 1000;
      label = "L 支撑做多";
    } else if (key === "O") {
      // O 价位做多（开盘突破）
      side = "buy";
      slOffset = -200;
      tpOffset = 1000;
      label = "O 开盘做多";
    } else {
      // C 价位做空（收盘压制）
      side = "sell";
      slOffset = 200;
      tpOffset = -1000;
      label = "C 收盘做空";
    }
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
            <span className="text-right">O</span>
            <span className="text-right text-red-500">H</span>
            <span className="text-right text-green-600">L</span>
            <span className="text-right">C</span>
          </div>

          {dailies.length === 0 ? (
            <div className="text-[9px] text-gray-400 py-1">加载中...</div>
          ) : (
            dailies.map((day) => (
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