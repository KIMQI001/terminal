"use client";

import { useState, useEffect, useCallback } from "react";
import { useChartStore } from "@/stores/chartStore";
import { useUserStore } from "@/stores/userStore";

// localStorage keys
const STORAGE_KEY_BASE_MARGIN = "liq_grid_base_margin";
const STORAGE_KEY_MARGIN_PER_LEVEL = "liq_grid_margin_per_level";
const STORAGE_KEY_LEVERAGE = "liq_grid_leverage";
const STORAGE_KEY_UPDATE_INTERVAL = "liq_grid_update_interval";

interface LiquidationLevel {
  price: number;
  volume: number;
  side: "long" | "short";
}

interface GridOrder {
  entryPrice: number;
  side: "BUY" | "SELL";
  tpPrice: number;
}

export function LiquidityGridPanel() {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [isManaged, setIsManaged] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState<Date | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");

  // 策略参数
  const [baseMargin, setBaseMargin] = useState(() => {
    if (typeof window !== "undefined") {
      return Number(localStorage.getItem(STORAGE_KEY_BASE_MARGIN)) || 50;
    }
    return 50;
  });
  const [marginPerLevel, setMarginPerLevel] = useState(() => {
    if (typeof window !== "undefined") {
      return Number(localStorage.getItem(STORAGE_KEY_MARGIN_PER_LEVEL)) || 10;
    }
    return 10;
  });
  const [leverage, setLeverage] = useState(() => {
    if (typeof window !== "undefined") {
      return Number(localStorage.getItem(STORAGE_KEY_LEVERAGE)) || 10;
    }
    return 10;
  });
  const [updateInterval, setUpdateInterval] = useState(() => {
    if (typeof window !== "undefined") {
      return Number(localStorage.getItem(STORAGE_KEY_UPDATE_INTERVAL)) || 60;
    }
    return 60; // 默认60分钟
  });

  const { liquidationData, symbol } = useChartStore();
  const { token } = useUserStore();

  // 保存参数到 localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_BASE_MARGIN, String(baseMargin));
  }, [baseMargin]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_MARGIN_PER_LEVEL, String(marginPerLevel));
  }, [marginPerLevel]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_LEVERAGE, String(leverage));
  }, [leverage]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_UPDATE_INTERVAL, String(updateInterval));
  }, [updateInterval]);

  // 找出局部峰值
  const findPeaks = useCallback((levels: LiquidationLevel[], count: number): LiquidationLevel[] => {
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
  }, []);

  // 计算网格订单
  const calculateGridOrders = useCallback((): GridOrder[] => {
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
    const lowestShortPeak = shortPeaks.length > 0
      ? shortPeaks.reduce((min, p) => (p.price < min.price ? p : min), shortPeaks[0])
      : null;

    for (const peak of longPeaks) {
      const tpPrice = lowestShortPeak?.price || peak.price * 1.02;
      orders.push({
        entryPrice: peak.price,
        side: "BUY",
        tpPrice,
      });
    }

    // 空头清算峰 → 开空单（摸顶）→ 止盈设在多头清算峰（最近的）
    const highestLongPeak = longPeaks.length > 0
      ? longPeaks.reduce((max, p) => (p.price > max.price ? p : max), longPeaks[0])
      : null;

    for (const peak of shortPeaks) {
      const tpPrice = highestLongPeak?.price || peak.price * 0.98;
      orders.push({
        entryPrice: peak.price,
        side: "SELL",
        tpPrice,
      });
    }

    return orders.sort((a, b) => b.entryPrice - a.entryPrice);
  }, [liquidationData, findPeaks]);

  // 计算每层保证金
  const calculateMarginForLevel = useCallback((levelIndex: number): number => {
    return baseMargin + marginPerLevel * levelIndex;
  }, [baseMargin, marginPerLevel]);

  // 计算总保证金
  const totalMargin = useCallback(() => {
    const orders = calculateGridOrders();
    let total = 0;
    for (let i = 0; i < orders.length; i++) {
      total += calculateMarginForLevel(i);
    }
    return total;
  }, [calculateGridOrders, calculateMarginForLevel]);

  // 更新订单（取消旧订单，下新订单）
  const updateOrders = useCallback(async () => {
    if (!token) {
      setStatusMessage("请先登录");
      return;
    }

    const orders = calculateGridOrders();
    if (orders.length === 0) {
      setStatusMessage("没有检测到清算高峰");
      return;
    }

    setIsUpdating(true);
    setStatusMessage("更新中...");

    try {
      // 构建订单数据，每层保证金递增
      const ordersWithMargin = orders.map((o, i) => ({
        entryPrice: o.entryPrice,
        side: o.side,
        tpPrice: o.tpPrice,
        margin: calculateMarginForLevel(i),
      }));

      const response = await fetch("/api/liquidity-grid", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          symbol,
          leverage,
          orders: ordersWithMargin,
          cancelExisting: true, // 取消现有 liq_grid 订单
        }),
      });

      const data = await response.json();

      if (data.success) {
        const successCount = data.results?.filter((r: { success: boolean }) => r.success).length || 0;
        setStatusMessage(`更新成功: ${successCount}/${orders.length} 单`);
        setLastUpdateTime(new Date());
      } else {
        setStatusMessage(`更新失败: ${data.error}`);
      }
    } catch (error) {
      setStatusMessage(`更新出错: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setIsUpdating(false);
    }
  }, [token, symbol, leverage, calculateGridOrders, calculateMarginForLevel]);

  // 托管定时更新
  useEffect(() => {
    if (!isManaged) return;

    // 立即执行一次
    updateOrders();

    // 设置定时器
    const intervalMs = updateInterval * 60 * 1000;
    const timer = setInterval(() => {
      updateOrders();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isManaged, updateInterval, updateOrders]);

  // 停止托管
  const handleStopManage = async () => {
    setIsManaged(false);
    setStatusMessage("托管已停止");

    // 可选：取消所有 liq_grid 订单
    if (token) {
      try {
        await fetch("/api/liquidity-grid", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ symbol }),
        });
        setStatusMessage("托管已停止，订单已取消");
      } catch {
        setStatusMessage("托管已停止，订单取消失败");
      }
    }
  };

  const orderCount = calculateGridOrders().length;

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg mt-2">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-600">流动性网格</span>
          {isManaged && (
            <span className="px-1.5 py-0.5 text-[9px] bg-green-100 text-green-600 rounded">
              托管中
            </span>
          )}
        </div>
        <span className="text-gray-400 text-[10px]">
          {isCollapsed ? ">" : "v"}
        </span>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="px-3 py-2 space-y-3">
          {/* 策略参数 */}
          <div className="space-y-2">
            {/* 保证金设置 */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-12">保证金:</span>
              <input
                type="number"
                value={baseMargin}
                onChange={(e) => setBaseMargin(Number(e.target.value))}
                className="w-14 px-1 py-0.5 text-[10px] border rounded text-center"
                disabled={isManaged}
              />
              <span className="text-[10px] text-gray-400">+</span>
              <input
                type="number"
                value={marginPerLevel}
                onChange={(e) => setMarginPerLevel(Number(e.target.value))}
                className="w-12 px-1 py-0.5 text-[10px] border rounded text-center"
                disabled={isManaged}
              />
              <span className="text-[10px] text-gray-400">U/层</span>
            </div>

            {/* 杠杆设置 */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-12">杠杆:</span>
              <input
                type="number"
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="w-14 px-1 py-0.5 text-[10px] border rounded text-center"
                disabled={isManaged}
              />
              <span className="text-[10px] text-gray-400">x</span>
            </div>

            {/* 更新间隔 */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-12">间隔:</span>
              <select
                value={updateInterval}
                onChange={(e) => setUpdateInterval(Number(e.target.value))}
                className="px-1 py-0.5 text-[10px] border rounded"
                disabled={isManaged}
              >
                <option value={15}>15 分钟</option>
                <option value={30}>30 分钟</option>
                <option value={60}>1 小时</option>
                <option value={120}>2 小时</option>
                <option value={240}>4 小时</option>
              </select>
            </div>
          </div>

          {/* 统计信息 */}
          <div className="bg-gray-50 rounded p-2 space-y-1">
            <div className="flex justify-between text-[10px]">
              <span className="text-gray-500">订单数量:</span>
              <span className="font-mono">{orderCount} 单</span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span className="text-gray-500">总保证金:</span>
              <span className="font-mono">{totalMargin().toFixed(0)} USDT</span>
            </div>
            {lastUpdateTime && (
              <div className="flex justify-between text-[10px]">
                <span className="text-gray-500">上次更新:</span>
                <span className="font-mono">
                  {lastUpdateTime.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            )}
          </div>

          {/* 状态消息 */}
          {statusMessage && (
            <div className={`text-[10px] px-2 py-1 rounded ${
              statusMessage.includes("成功") ? "bg-green-50 text-green-600" :
              statusMessage.includes("失败") || statusMessage.includes("出错") ? "bg-red-50 text-red-600" :
              "bg-gray-50 text-gray-600"
            }`}>
              {statusMessage}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex gap-2">
            {!isManaged ? (
              <>
                <button
                  onClick={updateOrders}
                  disabled={isUpdating || orderCount === 0}
                  className="flex-1 py-1.5 text-[11px] font-semibold bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isUpdating ? "更新中..." : "更新订单"}
                </button>
                <button
                  onClick={() => setIsManaged(true)}
                  disabled={orderCount === 0}
                  className="flex-1 py-1.5 text-[11px] font-semibold bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  启动托管
                </button>
              </>
            ) : (
              <button
                onClick={handleStopManage}
                className="w-full py-1.5 text-[11px] font-semibold bg-red-500 text-white rounded hover:bg-red-600"
              >
                停止托管
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
