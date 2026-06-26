"use client";

/**
 * 日K锚点面板
 * - 当前价格向左找到的第一个日K（含 4D K线参考）
 * - 竖排显示 O/H/L/C
 * - 点击 H → 做空（H 价位，SL = H + 200）
 * - 点击 L → 做多（L 价位，SL = L - 200）
 */

import { useState, useEffect } from "react";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore } from "@/stores/orderStore";
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
  // kline-server 返回的是秒，需要 *1000
  const d = new Date(ts * 1000);
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

/**
 * 把日K聚合成 N 日K（例如 4D = 每 4 根日K合并）
 */
function aggregateNDaily(dailyKlines: AnchorCandle[], n: number): AnchorCandle[] {
  const result: AnchorCandle[] = [];
  // 从右往左分组成 N 根一组
  const len = dailyKlines.length;
  const groupCount = Math.floor(len / n);
  for (let g = groupCount - 1; g >= 0; g--) {
    const start = g * n;
    const end = start + n;
    const group = dailyKlines.slice(start, end);
    if (group.length === 0) continue;
    const time = group[0].time;
    const open = group[0].open;
    const close = group[group.length - 1].close;
    const high = Math.max(...group.map((c) => c.high));
    const low = Math.min(...group.map((c) => c.low));
    result.push({ time, open, high, low, close });
  }
  // 按时间升序（从左到右：旧→新）
  return result.reverse();
}

export function DailyKPanel() {
  const { symbol, candles } = useChartStore();
  const { setPrefillData, openModal } = useOrderStore();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [dailyAnchor, setDailyAnchor] = useState<AnchorResult | null>(null);
  const [fourDayAnchor, setFourDayAnchor] = useState<AnchorResult | null>(null);

  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;

  useEffect(() => {
    if (!symbol || currentPrice <= 0) return;

    let cancelled = false;

    const load = async () => {
      try {
        const dailyData = await fetchKlines(symbol, "1d", 200);
        if (cancelled || dailyData.length < 2) return;

        // 1D 锚点
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

        // 4D 锚点（参考）—— 从日K聚合成 4D
        const fourDKlines = aggregateNDaily(dailyData, 4);
        const fCandle = findAnchor(fourDKlines, currentPrice);
        if (!cancelled) {
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
        // 静默失败
      }
    };

    load();
    return () => { cancelled = true; };
  }, [symbol, currentPrice]);

  // 点击 H/L 只预填表单（跟 OTE 面板一样），不直接下单
  const handleClickPrice = (
    side: "buy" | "sell",
    entryPrice: number
  ) => {
    if (entryPrice <= 0) return;
    const slOffset = side === "buy" ? -200 : 200;
    const tpOffset = side === "buy" ? 1000 : -1000;
    setPrefillData({
      side,
      entry: entryPrice,
      stopLoss: entryPrice + slOffset,
      takeProfit: entryPrice + tpOffset,
    });
    openModal();
  };

  // 渲染单根锚点K线（O/H/L/C 四个价位按钮 + 当前位置条）
  const renderAnchorColumn = (
    label: string,
    anchor: AnchorResult | null,
    colorClass: string
  ) => {
    if (!anchor) {
      return (
        <div className="text-[9px] text-gray-300 py-1">-</div>
      );
    }
    const { candle, positionPercent } = anchor;

    // 通用价位按钮：高于现价→做空，低于现价→做多
    const renderLevel = (key: string, value: number) => {
      const isAbove = value >= currentPrice;
      const side = isAbove ? "sell" : "buy";
      const arrow = isAbove ? "↓" : "↑";
      const action = isAbove ? "做空" : "做多";
      const labelClass = isAbove ? "text-red-500" : "text-green-500";
      const valueClass = isAbove ? "text-red-600" : "text-green-600";
      const hoverClass = isAbove ? "hover:bg-red-50" : "hover:bg-green-50";
      return (
        <button
          onClick={() => handleClickPrice(side, value)}
          className={`w-full flex justify-between px-1 py-0.5 ${hoverClass} border border-gray-200 rounded transition-colors cursor-pointer`}
          title={`${key} 价位 ${isAbove ? "高于" : "低于"}现价，点击预填${action}`}
        >
          <span className={labelClass}>{key} {arrow}</span>
          <span className={`${valueClass} font-semibold`}>{value.toFixed(1)}</span>
        </button>
      );
    };

    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[9px]">
          <span className={`font-semibold ${colorClass}`}>{label}</span>
          <span className="text-gray-500 font-mono">{formatTime(candle.time)}</span>
        </div>
        <div className="space-y-0.5 font-mono text-[10px]">
          {renderLevel("O", candle.open)}
          {renderLevel("H", candle.high)}
          {renderLevel("L", candle.low)}
          {renderLevel("C", candle.close)}
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
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg">
      {/* 标题栏 - 折叠按钮 */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="text-xs font-semibold text-gray-600">日K锚点 (点击开单)</span>
        <span className="text-gray-400 text-[10px]">{isCollapsed ? '▶' : '▼'}</span>
      </div>

      {/* 内容区 - 左右两栏 */}
      {!isCollapsed && (
        <div className="flex">
          {/* 左侧: 1D */}
          <div className="px-2 py-2 w-[200px]">
            {renderAnchorColumn("1D", dailyAnchor, "text-blue-600")}
          </div>

          <div className="w-px bg-gray-200 my-2" />

          {/* 右侧: 4D */}
          <div className="px-2 py-2 min-w-[130px]">
            {renderAnchorColumn("4D", fourDayAnchor, "text-purple-600")}
          </div>
        </div>
      )}
    </div>
  );
}
