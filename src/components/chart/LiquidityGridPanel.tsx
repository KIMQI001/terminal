"use client";

import { useState, useMemo } from "react";
import { useChartStore } from "@/stores/chartStore";
import { useUserStore } from "@/stores/userStore";

interface LiquidationLevel {
  price: number;
  volume: number;
  side: "long" | "short";
}

interface GridOrder {
  entryPrice: number;
  side: "BUY" | "SELL";
  tpPrice: number;
  profitPoints: number;
  volume: number;
}

interface PlaceOrderResult {
  success: boolean;
  orderId?: number;
  clientOrderId?: string;
  error?: string;
}

export function LiquidityGridPanel() {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [isPlacing, setIsPlacing] = useState(false);
  const [results, setResults] = useState<PlaceOrderResult[]>([]);
  const [amountPerOrder, setAmountPerOrder] = useState(100);
  const [leverage, setLeverage] = useState(10);

  const { liquidationData, symbol } = useChartStore();
  const { token } = useUserStore();

  // 找出局部峰值（复用 LiquidationPanel 的逻辑）
  const findPeaks = (levels: LiquidationLevel[], count: number): LiquidationLevel[] => {
    if (levels.length === 0) return [];

    const sorted = [...levels].sort((a, b) => a.price - b.price);
    const allPeaks: LiquidationLevel[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const prev = sorted[i - 1]?.volume || 0;
      const curr = sorted[i].volume;
      const next = sorted[i + 1]?.volume || 0;

      if (curr > prev && curr > next) {
        allPeaks.push(sorted[i]);
      } else if (i === 0 && curr > next) {
        allPeaks.push(sorted[i]);
      } else if (i === sorted.length - 1 && curr > prev) {
        allPeaks.push(sorted[i]);
      }
    }

    allPeaks.sort((a, b) => b.volume - a.volume);

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

    return filteredPeaks.sort((a, b) => b.price - a.price);
  };

  // 计算网格订单
  const gridOrders = useMemo(() => {
    if (!liquidationData?.levels) return [];

    const levels: LiquidationLevel[] = liquidationData.levels.map((l) => ({
      price: l.price,
      volume: l.amount,
      side: l.side,
    }));

    const longLevels = levels.filter((l) => l.side === "long");
    const shortLevels = levels.filter((l) => l.side === "short");

    const longPeaks = findPeaks(longLevels, 5);
    const shortPeaks = findPeaks(shortLevels, 5);

    const orders: GridOrder[] = [];

    // 多头清算峰 → 开多单（抄底）→ 止盈设在空头清算峰（最近的）
    // 止盈: 空头峰中价格最低的（最接近当前价的）
    const lowestShortPeak = shortPeaks.length > 0
      ? shortPeaks.reduce((min, p) => (p.price < min.price ? p : min), shortPeaks[0])
      : null;

    for (const peak of longPeaks) {
      const tpPrice = lowestShortPeak?.price || peak.price * 1.02;
      orders.push({
        entryPrice: peak.price,
        side: "BUY",
        tpPrice,
        profitPoints: tpPrice - peak.price,
        volume: peak.volume,
      });
    }

    // 空头清算峰 → 开空单（摸顶）→ 止盈设在多头清算峰（最近的）
    // 止盈: 多头峰中价格最高的（最接近当前价的）
    const highestLongPeak = longPeaks.length > 0
      ? longPeaks.reduce((max, p) => (p.price > max.price ? p : max), longPeaks[0])
      : null;

    for (const peak of shortPeaks) {
      const tpPrice = highestLongPeak?.price || peak.price * 0.98;
      orders.push({
        entryPrice: peak.price,
        side: "SELL",
        tpPrice,
        profitPoints: peak.price - tpPrice,
        volume: peak.volume,
      });
    }

    // 按价格排序（高到低）
    return orders.sort((a, b) => b.entryPrice - a.entryPrice);
  }, [liquidationData]);

  // 格式化金额
  const formatVolume = (vol: number): string => {
    if (vol >= 1e9) return `${(vol / 1e9).toFixed(1)}B`;
    if (vol >= 1e6) return `${(vol / 1e6).toFixed(1)}M`;
    if (vol >= 1e3) return `${(vol / 1e3).toFixed(1)}K`;
    return vol.toFixed(0);
  };

  // 一键下单
  const handlePlaceOrders = async () => {
    if (!token) {
      alert("请先登录");
      return;
    }

    if (gridOrders.length === 0) {
      alert("没有可下的订单");
      return;
    }

    const confirmed = window.confirm(
      `确认下单 ${gridOrders.length} 个限价单？\n每单金额: ${amountPerOrder} USDT\n杠杆: ${leverage}x\n交易对: ${symbol}`
    );

    if (!confirmed) return;

    setIsPlacing(true);
    setResults([]);

    try {
      const response = await fetch("/api/liquidity-grid", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          symbol,
          leverage,
          amountPerOrder,
          orders: gridOrders.map((o) => ({
            entryPrice: o.entryPrice,
            side: o.side,
            tpPrice: o.tpPrice,
          })),
        }),
      });

      const data = await response.json();

      if (data.success) {
        setResults(data.results || []);
        alert(`成功下单 ${data.results?.filter((r: PlaceOrderResult) => r.success).length || 0} 个订单`);
      } else {
        alert(`下单失败: ${data.error}`);
      }
    } catch (error) {
      alert(`下单出错: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setIsPlacing(false);
    }
  };

  const buyOrders = gridOrders.filter((o) => o.side === "BUY");
  const sellOrders = gridOrders.filter((o) => o.side === "SELL");

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg mt-2">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-600">Liquidity Grid</span>
          <span className="text-[9px] text-gray-400">({gridOrders.length} orders)</span>
        </div>
        <span className="text-gray-400 text-[10px]">
          {isCollapsed ? ">" : "v"}
        </span>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="px-3 py-2">
          {/* Config */}
          <div className="flex items-center gap-3 mb-3">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500">金额:</span>
              <input
                type="number"
                value={amountPerOrder}
                onChange={(e) => setAmountPerOrder(Number(e.target.value))}
                className="w-16 px-1 py-0.5 text-[10px] border rounded"
              />
              <span className="text-[10px] text-gray-400">USDT</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500">杠杆:</span>
              <input
                type="number"
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="w-12 px-1 py-0.5 text-[10px] border rounded"
              />
              <span className="text-[10px] text-gray-400">x</span>
            </div>
          </div>

          {/* Orders Preview */}
          {gridOrders.length > 0 ? (
            <div className="space-y-2">
              {/* Buy Orders (Long peaks - 抄底) */}
              {buyOrders.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-green-600 mb-1">
                    做多 ({buyOrders.length}) - 抄底
                  </div>
                  <div className="space-y-0.5">
                    {buyOrders.map((order, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between text-[9px] bg-green-50 px-1.5 py-0.5 rounded border border-green-200"
                      >
                        <span className="font-mono">${order.entryPrice.toFixed(2)}</span>
                        <span className="text-gray-500">→</span>
                        <span className="font-mono text-green-600">${order.tpPrice.toFixed(2)}</span>
                        <span className="text-green-600 font-semibold">+{order.profitPoints.toFixed(1)}</span>
                        <span className="text-gray-400">{formatVolume(order.volume)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sell Orders (Short peaks - 摸顶) */}
              {sellOrders.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-red-600 mb-1">
                    做空 ({sellOrders.length}) - 摸顶
                  </div>
                  <div className="space-y-0.5">
                    {sellOrders.map((order, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between text-[9px] bg-red-50 px-1.5 py-0.5 rounded border border-red-200"
                      >
                        <span className="font-mono">${order.entryPrice.toFixed(2)}</span>
                        <span className="text-gray-500">→</span>
                        <span className="font-mono text-red-600">${order.tpPrice.toFixed(2)}</span>
                        <span className="text-red-600 font-semibold">+{order.profitPoints.toFixed(1)}</span>
                        <span className="text-gray-400">{formatVolume(order.volume)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Place Order Button */}
              <button
                onClick={handlePlaceOrders}
                disabled={isPlacing || gridOrders.length === 0}
                className="w-full mt-2 py-1.5 text-[11px] font-semibold bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPlacing ? "下单中..." : `一键下单 (${gridOrders.length})`}
              </button>

              {/* Results */}
              {results.length > 0 && (
                <div className="mt-2 text-[9px]">
                  <div className="text-gray-500 mb-1">下单结果:</div>
                  <div className="max-h-20 overflow-y-auto space-y-0.5">
                    {results.map((r, i) => (
                      <div
                        key={i}
                        className={`px-1 py-0.5 rounded ${
                          r.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                        }`}
                      >
                        {r.success ? `#${r.orderId}` : r.error}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-4 text-[10px] text-gray-500">
              {liquidationData ? "没有检测到清算高峰" : "请先加载清算地图数据"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
