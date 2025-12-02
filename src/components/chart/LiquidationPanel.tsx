"use client";

import { useState, useEffect, useCallback } from "react";
import { useChartStore } from "@/stores/chartStore";
import type { LiquidationBar } from "@/lib/chart/primitives";

interface LiquidationLevel {
  price: number;
  volume: number;
  side: "long" | "short";
  risk: "h1" | "h2" | "h3";  // h1=高风险红色, h2=中风险橙色, h3=低风险黄色
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

  const { symbol, setLiquidationData } = useChartStore();

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

        // CoinAnk API returns: { prices: [...], Binance: [...], lastPrice, lastIndex }
        // lastIndex: 当前价格在 prices 数组中的索引，用于区分多空
        // - 索引 < lastIndex: 多头清算区（价格下方，做多被清算）
        // - 索引 > lastIndex: 空头清算区（价格上方，做空被清算）
        const prices = rawData.prices as number[] | undefined;
        const binanceData = rawData.Binance as number[] | undefined;
        const lastIndex = rawData.lastIndex as number | undefined;

        if (prices && binanceData && lastIndex !== undefined) {
          // 推断索引乘数（每5个元素为一组）
          const indexMultiplier = binanceData.length === prices.length ? 1 : 5;
          const GROUP_SIZE = 10; // 每10个价格点聚合为一组

          // 按价格区间聚合
          for (let groupStart = 0; groupStart < prices.length; groupStart += GROUP_SIZE) {
            const groupEnd = Math.min(groupStart + GROUP_SIZE, prices.length);
            let totalAmount = 0;

            // 聚合该区间内的清算量
            for (let i = groupStart; i < groupEnd; i++) {
              const dataIndex = i * indexMultiplier;
              if (dataIndex < binanceData.length) {
                totalAmount += binanceData[dataIndex] || 0;
              }
            }

            if (totalAmount > 0) {
              // 取区间中点的价格
              const middleIndex = Math.floor((groupStart + groupEnd) / 2);
              const price = prices[middleIndex] || prices[groupStart];

              // 根据 lastIndex 判断多空
              // 价格 < 当前价（索引 < lastIndex）：多头清算区
              // 价格 > 当前价（索引 > lastIndex）：空头清算区
              const side: "long" | "short" = middleIndex < lastIndex ? "long" : "short";

              // 风险等级
              const risk: "h1" | "h2" | "h3" =
                totalAmount > 100e6 ? "h1" :
                totalAmount > 50e6 ? "h2" : "h3";

              levels.push({ price, volume: totalAmount, side, risk });
            }
          }
        }

        const currentPrice = rawData.lastPrice || 0;
        setData({
          symbol: result.symbol || baseCoin,
          interval: result.interval || selectedInterval,
          levels,
          currentPrice,
          timestamp: result.timestamp || new Date().toISOString(),
        });
        setRelayStatus("connected");

        // Send data to store for chart primitive
        const chartLevels: LiquidationBar[] = levels.map(l => ({
          price: l.price,
          amount: l.volume,
          side: l.side,
        }));
        setLiquidationData({ levels: chartLevels, currentPrice });
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
  }, [baseCoin, selectedInterval, setLiquidationData]);

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

  // Get top liquidation levels - 分别从多空各取 top 5，按清算量排序
  const allLongLevels = data?.levels.filter((l) => l.side === "long") || [];
  const allShortLevels = data?.levels.filter((l) => l.side === "short") || [];

  // 各取清算量最大的 5 个，然后按价格排序显示
  const longLevels = [...allLongLevels]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5)
    .sort((a, b) => b.price - a.price); // 按价格从高到低

  const shortLevels = [...allShortLevels]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5)
    .sort((a, b) => b.price - a.price); // 按价格从高到低

  // Status indicator color
  const statusColor = {
    connected: "bg-green-500",
    disconnected: "bg-red-500",
    unknown: "bg-gray-400",
  }[relayStatus];

  // Risk level colors
  const getRiskColor = (risk: "h1" | "h2" | "h3", side: "long" | "short") => {
    // h1=高风险, h2=中风险, h3=低风险
    const riskColors = {
      h1: { bg: "bg-red-100", text: "text-red-600", border: "border-red-300" },
      h2: { bg: "bg-orange-100", text: "text-orange-600", border: "border-orange-300" },
      h3: { bg: "bg-yellow-100", text: "text-yellow-600", border: "border-yellow-300" },
    };
    return riskColors[risk];
  };

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
          {data && (longLevels.length > 0 || shortLevels.length > 0) ? (
            <div className="flex gap-3">
              {/* Long liquidations - 多头清算区（价格下方） */}
              <div className="flex-1">
                <div className="text-[10px] font-semibold text-blue-600 mb-1">
                  Long Liq ({longLevels.length})
                </div>
                <div className="space-y-0.5">
                  {longLevels.map((level, i) => {
                    const colors = getRiskColor(level.risk, level.side);
                    return (
                      <div
                        key={i}
                        className={`flex justify-between text-[9px] ${colors.bg} px-1.5 py-0.5 rounded border ${colors.border}`}
                      >
                        <span className="font-mono">${level.price.toFixed(0)}</span>
                        <span className={`${colors.text} font-semibold`}>
                          {formatVolume(level.volume)}
                        </span>
                      </div>
                    );
                  })}
                  {longLevels.length === 0 && (
                    <div className="text-[9px] text-gray-400">No data</div>
                  )}
                </div>
              </div>

              {/* Short liquidations - 空头清算区（价格上方） */}
              <div className="flex-1">
                <div className="text-[10px] font-semibold text-orange-600 mb-1">
                  Short Liq ({shortLevels.length})
                </div>
                <div className="space-y-0.5">
                  {shortLevels.map((level, i) => {
                    const colors = getRiskColor(level.risk, level.side);
                    return (
                      <div
                        key={i}
                        className={`flex justify-between text-[9px] ${colors.bg} px-1.5 py-0.5 rounded border ${colors.border}`}
                      >
                        <span className="font-mono">${level.price.toFixed(0)}</span>
                        <span className={`${colors.text} font-semibold`}>
                          {formatVolume(level.volume)}
                        </span>
                      </div>
                    );
                  })}
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
