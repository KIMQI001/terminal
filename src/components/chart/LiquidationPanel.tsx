"use client";

import { useState, useEffect, useCallback } from "react";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore, TradingLine } from "@/stores/orderStore";
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
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LiquidationData | null>(null);
  const [selectedInterval, setSelectedInterval] = useState<string>("1d");
  const [relayStatus, setRelayStatus] = useState<"connected" | "disconnected" | "unknown">("unknown");

  const { symbol, setLiquidationData, dailyHL } = useChartStore();
  const { setPrefillData, setTradingLines, openModal } = useOrderStore();

  // 计算 P/D 价格（日K前高前低的四分位）
  const pPrice = dailyHL ? dailyHL.high - (dailyHL.high - dailyHL.low) / 4 : null;  // 溢价区开始
  const dPrice = dailyHL ? dailyHL.low + (dailyHL.high - dailyHL.low) / 4 : null;   // 折扣区开始

  // 点击清算价格开单
  const handleLiqClick = (level: LiquidationLevel) => {
    const liqPrice = level.price;
    const side = level.side === "short" ? "sell" : "buy";

    // 空头清算 → 开空单：入场-0.2%，止损+0.1%，止盈-1.5%
    // 多头清算 → 开多单：入场+0.2%，止损-0.1%，止盈+1.5%
    const entry = level.side === "short"
      ? liqPrice * 0.998   // 入场：清算价 - 0.2%
      : liqPrice * 1.002;  // 入场：清算价 + 0.2%
    const stopLoss = level.side === "short"
      ? liqPrice * 1.001   // 止损：清算价 + 0.1%
      : liqPrice * 0.999;  // 止损：清算价 - 0.1%
    const takeProfit = level.side === "short"
      ? liqPrice * 0.985   // 止盈：清算价 - 1.5%
      : liqPrice * 1.015;  // 止盈：清算价 + 1.5%

    const lines: TradingLine[] = [
      { price: entry, type: "entry", side },
      { price: stopLoss, type: "stopLoss", side },
      { price: takeProfit, type: "takeProfit", side },
    ];

    setTradingLines(lines);
    setPrefillData({ side, entry, stopLoss, takeProfit });
    openModal();
  };

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

              // 风险等级（根据实际数据范围调整）
              const risk: "h1" | "h2" | "h3" =
                totalAmount > 800e6 ? "h1" :
                totalAmount > 500e6 ? "h2" : "h3";

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

  // Auto-load data and refresh every 2 minutes
  useEffect(() => {
    if (!baseCoin) return;

    fetchData();

    const interval = setInterval(() => {
      fetchData();
    }, 2 * 60 * 1000); // 2分钟

    return () => clearInterval(interval);
  }, [baseCoin, selectedInterval, fetchData]);

  // Format volume for display
  const formatVolume = (vol: number): string => {
    if (vol >= 1e9) return `${(vol / 1e9).toFixed(1)}B`;
    if (vol >= 1e6) return `${(vol / 1e6).toFixed(1)}M`;
    if (vol >= 1e3) return `${(vol / 1e3).toFixed(1)}K`;
    return vol.toFixed(0);
  };

  // 找出局部峰值（山峰）- 比相邻价位清算量都大的点，且相邻峰值间距至少 0.2%
  const findPeaks = (levels: LiquidationLevel[], count: number): LiquidationLevel[] => {
    if (levels.length === 0) return [];

    // 按价格排序
    const sorted = [...levels].sort((a, b) => a.price - b.price);

    // 找出所有局部峰值
    const allPeaks: LiquidationLevel[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const prev = sorted[i - 1]?.volume || 0;
      const curr = sorted[i].volume;
      const next = sorted[i + 1]?.volume || 0;

      // 当前值比前后都大，或者是边界且比相邻大
      if (curr > prev && curr > next) {
        allPeaks.push(sorted[i]);
      } else if (i === 0 && curr > next) {
        allPeaks.push(sorted[i]);
      } else if (i === sorted.length - 1 && curr > prev) {
        allPeaks.push(sorted[i]);
      }
    }

    // 按清算量从大到小排序
    allPeaks.sort((a, b) => b.volume - a.volume);

    // 过滤掉距离太近的峰值（保留较大的）
    // 最小距离 = 价格的 0.2%（约 200 点对于 BTC）
    const MIN_DISTANCE_RATIO = 0.002;
    const filteredPeaks: LiquidationLevel[] = [];

    for (const peak of allPeaks) {
      const minDistance = peak.price * MIN_DISTANCE_RATIO;
      const isTooClose = filteredPeaks.some(
        (p) => Math.abs(p.price - peak.price) < minDistance
      );

      if (!isTooClose) {
        filteredPeaks.push(peak);
      }

      if (filteredPeaks.length >= count) break;
    }

    // 按价格从高到低显示
    return filteredPeaks.sort((a, b) => b.price - a.price);
  };

  const allLongLevels = data?.levels.filter((l) => l.side === "long") || [];
  const allShortLevels = data?.levels.filter((l) => l.side === "short") || [];

  // 找出清算量最大的几个山峰
  const longLevels = findPeaks(allLongLevels, 5);
  const shortLevels = findPeaks(allShortLevels, 5);

  // 找出清算量最大的价格
  const maxLongVolume = longLevels.length > 0 ? Math.max(...longLevels.map(l => l.volume)) : 0;
  const maxShortVolume = shortLevels.length > 0 ? Math.max(...shortLevels.map(l => l.volume)) : 0;

  // 找出 D 以下最大的多头清算价格（折扣区内）
  const maxLongBelowD = dPrice
    ? longLevels.filter(l => l.price < dPrice).reduce((max, l) => l.volume > (max?.volume || 0) ? l : max, null as LiquidationLevel | null)
    : null;

  // 找出 P 以上最大的空头清算价格（溢价区内）
  const maxShortAboveP = pPrice
    ? shortLevels.filter(l => l.price > pPrice).reduce((max, l) => l.volume > (max?.volume || 0) ? l : max, null as LiquidationLevel | null)
    : null;

  // Status indicator color
  const statusColor = {
    connected: "bg-green-500",
    disconnected: "bg-red-500",
    unknown: "bg-gray-400",
  }[relayStatus];

  // Side colors - 多头蓝色，空头橙色（与图表柱子颜色一致）
  const getSideColor = (side: "long" | "short") => {
    if (side === "long") {
      return { bg: "bg-blue-50", text: "text-blue-600", border: "border-blue-200" };
    } else {
      return { bg: "bg-orange-50", text: "text-orange-600", border: "border-orange-200" };
    }
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
                    const colors = getSideColor(level.side);
                    const isMax = level.volume === maxLongVolume;
                    const isMaxBelowD = maxLongBelowD && level.price === maxLongBelowD.price;
                    return (
                      <div
                        key={i}
                        onClick={() => handleLiqClick(level)}
                        className={`flex justify-between text-[9px] px-1.5 py-0.5 rounded cursor-pointer hover:opacity-80 transition-opacity ${
                          isMax
                            ? "bg-blue-500 text-white border-2 border-blue-600 font-bold"
                            : isMaxBelowD
                            ? "bg-green-100 border-2 border-dashed border-green-500"
                            : `${colors.bg} border ${colors.border}`
                        }`}
                      >
                        <span className="font-mono">
                          ${level.price.toFixed(0)}
                          {isMaxBelowD && !isMax && <span className="ml-1 text-green-600">D</span>}
                        </span>
                        <span className={isMax ? "font-bold" : isMaxBelowD ? "text-green-600 font-semibold" : `${colors.text} font-semibold`}>
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
                    const colors = getSideColor(level.side);
                    const isMax = level.volume === maxShortVolume;
                    const isMaxAboveP = maxShortAboveP && level.price === maxShortAboveP.price;
                    return (
                      <div
                        key={i}
                        onClick={() => handleLiqClick(level)}
                        className={`flex justify-between text-[9px] px-1.5 py-0.5 rounded cursor-pointer hover:opacity-80 transition-opacity ${
                          isMax
                            ? "bg-orange-500 text-white border-2 border-orange-600 font-bold"
                            : isMaxAboveP
                            ? "bg-red-100 border-2 border-dashed border-red-500"
                            : `${colors.bg} border ${colors.border}`
                        }`}
                      >
                        <span className="font-mono">
                          ${level.price.toFixed(0)}
                          {isMaxAboveP && !isMax && <span className="ml-1 text-red-600">P</span>}
                        </span>
                        <span className={isMax ? "font-bold" : isMaxAboveP ? "text-red-600 font-semibold" : `${colors.text} font-semibold`}>
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
