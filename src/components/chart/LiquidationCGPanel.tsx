"use client";

import { useState, useEffect, useCallback } from "react";
import { useChartStore } from "@/stores/chartStore";

interface CGLiqData {
  symbol: string;
  lastPrice: number;
  timestamp: string;
  longTop: Array<{ price: number; amount: number }>;
  shortTop: Array<{ price: number; amount: number }>;
  longTotal: number;
  shortTotal: number;
}

export function LiquidationCGPanel() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CGLiqData | null>(null);
  const [status, setStatus] = useState<"connected" | "disconnected" | "unknown">("unknown");

  const { symbol } = useChartStore();

  // Extract base coin from symbol (e.g., "BTCUSDC" -> "BTC")
  const baseCoin = symbol.replace(/USDC?|USDT?|BUSD?/i, "");

  // 目前只支持 BTC
  const isSupported = baseCoin === "BTC";

  // Fetch data from Coinglass service
  const fetchData = useCallback(async () => {
    if (!isSupported) {
      setData(null);
      setStatus("disconnected");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/coinglass/liqmap?symbol=${baseCoin}&limit=5`
      );
      const result = await res.json();

      if (result.success && result.data) {
        setData(result.data);
        setStatus("connected");
      } else {
        setError(result.error || "Failed to fetch data");
        setStatus("disconnected");
      }
    } catch (err) {
      setError("Coinglass service unavailable");
      setStatus("disconnected");
    } finally {
      setIsLoading(false);
    }
  }, [baseCoin, isSupported]);

  // Auto-load data and refresh every 3 minutes
  useEffect(() => {
    fetchData();

    const interval = setInterval(() => {
      fetchData();
    }, 3 * 60 * 1000);

    return () => clearInterval(interval);
  }, [fetchData]);

  // Format volume for display
  const formatVolume = (vol: number): string => {
    if (vol >= 1e9) return `${(vol / 1e9).toFixed(2)}B`;
    if (vol >= 1e6) return `${(vol / 1e6).toFixed(0)}M`;
    if (vol >= 1e3) return `${(vol / 1e3).toFixed(0)}K`;
    return vol.toFixed(0);
  };

  // Status indicator color
  const statusColor = {
    connected: "bg-green-500",
    disconnected: "bg-red-500",
    unknown: "bg-gray-400",
  }[status];

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-600">Liquidation-CG</span>
          <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} title={status} />
        </div>
        <span className="text-gray-400 text-[10px]">
          {isCollapsed ? ">" : "v"}
        </span>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="px-3 py-2">
          {/* Controls */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-gray-500">Coinglass Data</span>
            <button
              onClick={fetchData}
              disabled={isLoading}
              className="px-2 py-0.5 text-[10px] bg-gray-100 text-gray-600 rounded hover:bg-gray-200 disabled:opacity-50"
            >
              {isLoading ? "..." : "Refresh"}
            </button>
          </div>

          {/* Not supported */}
          {!isSupported && (
            <div className="text-[9px] text-gray-400 text-center py-4">
              {baseCoin} 暂无数据
            </div>
          )}

          {/* Error */}
          {error && isSupported && (
            <div className="text-[9px] text-red-500 mb-2">
              {error}
            </div>
          )}

          {/* Data */}
          {data && isSupported && (
            <div className="flex gap-3">
              {/* Long liquidations */}
              <div className="flex-1">
                <div className="text-[10px] font-semibold text-blue-600 mb-1">
                  Long Top5
                </div>
                <div className="space-y-0.5">
                  {data.longTop.map((level, i) => (
                    <div
                      key={i}
                      className={`flex justify-between text-[9px] px-1.5 py-0.5 rounded ${
                        i === 0
                          ? "bg-blue-500 text-white font-bold"
                          : "bg-blue-50 border border-blue-200"
                      }`}
                    >
                      <span className="font-mono">${level.price.toFixed(0)}</span>
                      <span className={i === 0 ? "font-bold" : "text-blue-600 font-semibold"}>
                        {formatVolume(level.amount)}
                      </span>
                    </div>
                  ))}
                  {data.longTop.length === 0 && (
                    <div className="text-[9px] text-gray-400">No data</div>
                  )}
                </div>
              </div>

              {/* Short liquidations */}
              <div className="flex-1">
                <div className="text-[10px] font-semibold text-orange-600 mb-1">
                  Short Top5
                </div>
                <div className="space-y-0.5">
                  {data.shortTop.map((level, i) => (
                    <div
                      key={i}
                      className={`flex justify-between text-[9px] px-1.5 py-0.5 rounded ${
                        i === 0
                          ? "bg-orange-500 text-white font-bold"
                          : "bg-orange-50 border border-orange-200"
                      }`}
                    >
                      <span className="font-mono">${level.price.toFixed(0)}</span>
                      <span className={i === 0 ? "font-bold" : "text-orange-600 font-semibold"}>
                        {formatVolume(level.amount)}
                      </span>
                    </div>
                  ))}
                  {data.shortTop.length === 0 && (
                    <div className="text-[9px] text-gray-400">No data</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Totals & Timestamp */}
          {data && isSupported && (
            <div className="text-[8px] text-gray-400 mt-2 flex justify-between">
              <span>L: {formatVolume(data.longTotal)} | S: {formatVolume(data.shortTotal)}</span>
              <span>{new Date(data.timestamp).toLocaleTimeString()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
