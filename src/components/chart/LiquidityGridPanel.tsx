"use client";

import { useState, useEffect, useCallback } from "react";
import { useChartStore } from "@/stores/chartStore";
import { useUserStore } from "@/stores/userStore";

// localStorage keys (仅用于初始化默认值)
const STORAGE_KEY_BASE_MARGIN = "liq_grid_base_margin";
const STORAGE_KEY_MARGIN_PER_LEVEL = "liq_grid_margin_per_level";
const STORAGE_KEY_LEVERAGE = "liq_grid_leverage";
const STORAGE_KEY_UPDATE_INTERVAL = "liq_grid_update_interval";
const STORAGE_KEY_MAX_QUANTITY = "liq_grid_max_quantity";

interface ManagementConfig {
  id: number;
  userId: number;
  symbol: string;
  isActive: boolean;
  intervalMinutes: number;
  baseMargin: number;
  marginPerLevel: number;
  leverage: number;
  maxQuantity: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

interface ManagementStats {
  totalExecutions: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
}

export function LiquidityGridPanel() {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");

  // 服务端状态
  const [management, setManagement] = useState<ManagementConfig | null>(null);
  const [stats, setStats] = useState<ManagementStats | null>(null);

  // 策略参数（本地编辑状态）
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
    return 60;
  });
  const [maxQuantity, setMaxQuantity] = useState(() => {
    if (typeof window !== "undefined") {
      return Number(localStorage.getItem(STORAGE_KEY_MAX_QUANTITY)) || 0;
    }
    return 0;
  });

  const { symbol } = useChartStore();
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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_MAX_QUANTITY, String(maxQuantity));
  }, [maxQuantity]);

  // 从服务端加载托管状态
  const fetchManagement = useCallback(async () => {
    if (!token || !symbol) return;

    try {
      const response = await fetch(
        `/api/analysis/liq-grid-management?symbol=${symbol}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      const data = await response.json();
      if (data.success) {
        setManagement(data.management);
        setStats(data.stats);

        // 如果有服务端配置，同步到本地
        if (data.management) {
          setBaseMargin(data.management.baseMargin);
          setMarginPerLevel(data.management.marginPerLevel);
          setLeverage(data.management.leverage);
          setUpdateInterval(data.management.intervalMinutes);
          setMaxQuantity(data.management.maxQuantity || 0);
        }
      }
    } catch (error) {
      console.error("[LiqGridPanel] 获取托管状态失败:", error);
    }
  }, [token, symbol]);

  // 初始加载和 symbol 切换时获取状态（无论面板是否折叠）
  useEffect(() => {
    fetchManagement();
  }, [fetchManagement]);

  // 定时刷新状态（托管中时）
  useEffect(() => {
    if (!management?.isActive || isCollapsed) return;

    const timer = setInterval(() => {
      fetchManagement();
    }, 30 * 1000); // 每 30 秒刷新

    return () => clearInterval(timer);
  }, [management?.isActive, isCollapsed, fetchManagement]);

  // 计算总保证金（基于5层多单+5层空单）
  const totalMargin = useCallback(() => {
    let total = 0;
    // 多单 5 层
    for (let i = 0; i < 5; i++) {
      total += baseMargin + marginPerLevel * i;
    }
    // 空单 5 层
    for (let i = 0; i < 5; i++) {
      total += baseMargin + marginPerLevel * i;
    }
    return total;
  }, [baseMargin, marginPerLevel]);

  // 启动托管
  const handleStart = async () => {
    if (!token) {
      setStatusMessage("请先登录");
      return;
    }

    setIsLoading(true);
    setStatusMessage("启动中...");

    try {
      const response = await fetch("/api/analysis/liq-grid-management/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          symbol,
          intervalMinutes: updateInterval,
          baseMargin,
          marginPerLevel,
          leverage,
          maxQuantity,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setManagement(data.management);
        setStatusMessage("托管已启动");
      } else {
        setStatusMessage(`启动失败: ${data.error}`);
      }
    } catch (error) {
      setStatusMessage(`启动出错: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setIsLoading(false);
    }
  };

  // 停止托管
  const handleStop = async () => {
    if (!token) return;

    setIsLoading(true);
    setStatusMessage("停止中...");

    try {
      const response = await fetch("/api/analysis/liq-grid-management/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ symbol }),
      });

      const data = await response.json();
      if (data.success) {
        setManagement((prev) => (prev ? { ...prev, isActive: false } : null));
        setStatusMessage("托管已停止");
      } else {
        setStatusMessage(`停止失败: ${data.error}`);
      }
    } catch (error) {
      setStatusMessage(`停止出错: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setIsLoading(false);
    }
  };

  // 格式化时间
  const formatTime = (isoString: string | null) => {
    if (!isoString) return "-";
    const date = new Date(isoString);
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  };

  const isActive = management?.isActive ?? false;

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg mt-2">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-600">流动性网格</span>
          {isActive && (
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
                disabled={isActive}
              />
              <span className="text-[10px] text-gray-400">+</span>
              <input
                type="number"
                value={marginPerLevel}
                onChange={(e) => setMarginPerLevel(Number(e.target.value))}
                className="w-12 px-1 py-0.5 text-[10px] border rounded text-center"
                disabled={isActive}
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
                disabled={isActive}
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
                disabled={isActive}
              >
                <option value={15}>15 分钟</option>
                <option value={30}>30 分钟</option>
                <option value={60}>1 小时</option>
                <option value={120}>2 小时</option>
                <option value={240}>4 小时</option>
              </select>
            </div>

            {/* 最大数量 */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-12">最大:</span>
              <input
                type="number"
                value={maxQuantity}
                onChange={(e) => setMaxQuantity(Number(e.target.value))}
                className="w-14 px-1 py-0.5 text-[10px] border rounded text-center"
                disabled={isActive}
                step="0.1"
                min="0"
              />
              <span className="text-[10px] text-gray-400">ETH (0=不限)</span>
            </div>
          </div>

          {/* 统计信息 */}
          <div className="bg-gray-50 rounded p-2 space-y-1">
            <div className="flex justify-between text-[10px]">
              <span className="text-gray-500">预估保证金:</span>
              <span className="font-mono">{totalMargin().toFixed(0)} USDT</span>
            </div>
            {management && (
              <>
                <div className="flex justify-between text-[10px]">
                  <span className="text-gray-500">上次更新:</span>
                  <span className="font-mono">{formatTime(management.lastRunAt)}</span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-gray-500">下次更新:</span>
                  <span className="font-mono">{formatTime(management.nextRunAt)}</span>
                </div>
              </>
            )}
            {stats && (
              <div className="flex justify-between text-[10px]">
                <span className="text-gray-500">执行统计:</span>
                <span className="font-mono">
                  {stats.successCount}成功 / {stats.skippedCount}跳过 / {stats.failedCount}失败
                </span>
              </div>
            )}
          </div>

          {/* 状态消息 */}
          {statusMessage && (
            <div className={`text-[10px] px-2 py-1 rounded ${
              statusMessage.includes("成功") || statusMessage.includes("启动") || statusMessage.includes("停止")
                ? "bg-green-50 text-green-600"
                : statusMessage.includes("失败") || statusMessage.includes("出错")
                  ? "bg-red-50 text-red-600"
                  : "bg-gray-50 text-gray-600"
            }`}>
              {statusMessage}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex gap-2">
            {!isActive ? (
              <button
                onClick={handleStart}
                disabled={isLoading}
                className="w-full py-1.5 text-[11px] font-semibold bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? "启动中..." : "启动托管"}
              </button>
            ) : (
              <button
                onClick={handleStop}
                disabled={isLoading}
                className="w-full py-1.5 text-[11px] font-semibold bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? "停止中..." : "停止托管"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
