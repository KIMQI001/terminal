"use client";

import { useState, useEffect, useCallback } from "react";
import { useChartStore } from "@/stores/chartStore";

interface LiquidationLevel {
  price: number;
  volume: number;
  side: "long" | "short";
}

interface LiquidationData {
  symbol: string;
  interval: string;
  levels: LiquidationLevel[];
  currentPrice: number;
  timestamp: string;
}

const INTERVALS = ["1d", "1w", "1M"] as const;

export function LiquidationPanel() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LiquidationData | null>(null);
  const [selectedInterval, setSelectedInterval] = useState<string>("1d");
  const [relayStatus, setRelayStatus] = useState<"connected" | "disconnected" | "unknown">("unknown");

  const { symbol } = useChartStore();

  // Extract base coin from symbol (e.g., "BTCUSDC" -> "BTC")
  const baseCoin = symbol.replace(/USDC?|USDT?|BUSD?/i, "");

  // Check relay status
  const checkRelayStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/liquidation", { method: "HEAD" });
      const status = res.headers.get("X-Relay-Status");
      setRelayStatus(status === "connected" ? "connected" : "disconnected");
    } catch {
      setRelayStatus("unknown");
    }
  }, []);

  // Fetch liquidation data
  const fetchData = useCallback(async () => {
    if (!baseCoin) return;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/liquidation?symbol=${baseCoin}&interval=${selectedInterval}`
      );
      const result = await res.json();

      if (result.success && result.data) {
        // Parse CoinAnk data structure
        const rawData = result.data;
        const levels: LiquidationLevel[] = [];

        // CoinAnk API returns: { prices: [...], Binance: [...], Bybit: [...], lastPrice, lastIndex }
        // Each exchange array has format: [long1, short1, 0, 0, 0, long2, short2, 0, 0, 0, ...]
        // Every 5 elements represent one price level: [long, short, 0, 0, 0]
        const prices = rawData.prices as number[] | undefined;
        const binanceData = rawData.Binance as number[] | undefined;

        if (prices && binanceData) {
          // Parse Binance data (most liquid exchange)
          for (let i = 0; i < prices.length && i * 5 < binanceData.length; i++) {
            const price = prices[i];
            const dataIndex = i * 5;
            const longVol = binanceData[dataIndex] || 0;
            const shortVol = binanceData[dataIndex + 1] || 0;

            if (longVol > 0) {
              levels.push({ price, volume: longVol, side: "long" });
            }
            if (shortVol > 0) {
              levels.push({ price, volume: shortVol, side: "short" });
            }
          }
        }

        setData({
          symbol: result.symbol || baseCoin,
          interval: result.interval || selectedInterval,
          levels,
          currentPrice: rawData.lastPrice || 0,
          timestamp: result.timestamp || new Date().toISOString(),
        });
        setRelayStatus("connected");
      } else {
        setError(result.error || "Failed to fetch data");
        setRelayStatus("disconnected");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setRelayStatus("disconnected");
    } finally {
      setIsLoading(false);
    }
  }, [baseCoin, selectedInterval]);

  // Initial status check
  useEffect(() => {
    checkRelayStatus();
  }, [checkRelayStatus]);

  // Auto-load data when relay is connected or params change
  useEffect(() => {
    if (baseCoin) {
      fetchData();
    }
  }, [baseCoin, selectedInterval, fetchData]);

  // Format volume for display
  const formatVolume = (vol: number): string => {
    if (vol >= 1e9) return `${(vol / 1e9).toFixed(1)}B`;
    if (vol >= 1e6) return `${(vol / 1e6).toFixed(1)}M`;
    if (vol >= 1e3) return `${(vol / 1e3).toFixed(1)}K`;
    return vol.toFixed(0);
  };

  // Get top liquidation levels
  const topLevels = data?.levels
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10) || [];

  const longLevels = topLevels.filter((l) => l.side === "long");
  const shortLevels = topLevels.filter((l) => l.side === "short");

  // Status indicator color
  const statusColor = {
    connected: "bg-green-500",
    disconnected: "bg-red-500",
    unknown: "bg-gray-400",
  }[relayStatus];

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-600">Liquidation</span>
          <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} title={relayStatus} />
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
            <div className="flex gap-1">
              {INTERVALS.map((interval) => (
                <button
                  key={interval}
                  onClick={() => setSelectedInterval(interval)}
                  className={`px-2 py-0.5 text-[10px] rounded ${
                    selectedInterval === interval
                      ? "bg-blue-500 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {interval}
                </button>
              ))}
            </div>
            <button
              onClick={fetchData}
              disabled={isLoading}
              className="px-2 py-0.5 text-[10px] bg-gray-100 text-gray-600 rounded hover:bg-gray-200 disabled:opacity-50"
            >
              {isLoading ? "..." : "Refresh"}
            </button>
          </div>

          {/* Status */}
          {relayStatus === "disconnected" && (
            <div className="text-[9px] text-orange-500 mb-2">
              Tampermonkey not connected. Open coinank.com to enable.
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-[9px] text-red-500 mb-2">
              {error}
            </div>
          )}

          {/* Data */}
          {data && topLevels.length > 0 ? (
            <div className="flex gap-3">
              {/* Long liquidations */}
              <div className="flex-1">
                <div className="text-[10px] font-semibold text-green-600 mb-1">
                  Long Liq ({longLevels.length})
                </div>
                <div className="space-y-0.5">
                  {longLevels.map((level, i) => (
                    <div
                      key={i}
                      className="flex justify-between text-[9px] bg-green-50 px-1.5 py-0.5 rounded"
                    >
                      <span className="font-mono">${level.price.toFixed(0)}</span>
                      <span className="text-green-600 font-semibold">
                        {formatVolume(level.volume)}
                      </span>
                    </div>
                  ))}
                  {longLevels.length === 0 && (
                    <div className="text-[9px] text-gray-400">No data</div>
                  )}
                </div>
              </div>

              {/* Short liquidations */}
              <div className="flex-1">
                <div className="text-[10px] font-semibold text-red-600 mb-1">
                  Short Liq ({shortLevels.length})
                </div>
                <div className="space-y-0.5">
                  {shortLevels.map((level, i) => (
                    <div
                      key={i}
                      className="flex justify-between text-[9px] bg-red-50 px-1.5 py-0.5 rounded"
                    >
                      <span className="font-mono">${level.price.toFixed(0)}</span>
                      <span className="text-red-600 font-semibold">
                        {formatVolume(level.volume)}
                      </span>
                    </div>
                  ))}
                  {shortLevels.length === 0 && (
                    <div className="text-[9px] text-gray-400">No data</div>
                  )}
                </div>
              </div>
            </div>
          ) : !isLoading && !error ? (
            <div className="text-center py-4">
              <div className="text-[10px] text-gray-500 mb-2">
                Click Refresh to load {baseCoin} liquidation data
              </div>
            </div>
          ) : null}

          {/* Timestamp */}
          {data?.timestamp && (
            <div className="text-[8px] text-gray-400 mt-2 text-right">
              Updated: {new Date(data.timestamp).toLocaleTimeString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
