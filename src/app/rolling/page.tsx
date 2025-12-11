"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { useChartStore } from "@/stores/chartStore";
import { useUserStore } from "@/stores/userStore";

// localStorage keys
const STORAGE_KEYS = {
  INITIAL_MARGIN: "rolling_initial_margin",
  LEVERAGE: "rolling_leverage",
  ROLL_INTERVAL: "rolling_interval",
  ROLL_PROFIT_RATIO: "rolling_profit_ratio",
  STOP_LOSS_RATIO: "rolling_stop_loss",
  TAKE_PROFIT_RATIO: "rolling_take_profit",
  GRID_SPACING: "rolling_grid_spacing",
  GRID_COUNT: "rolling_grid_count",
  ORDER_SIZE: "rolling_order_size",
  MAX_POSITION: "rolling_max_position",
  TARGET_PRICE: "rolling_target_price",
  STOP_ROLL_DISTANCE: "rolling_stop_roll_distance",
};

// 滚仓服务状态
interface RollingServiceStatus {
  isRunning: boolean;
  direction: 'long' | 'short' | null;
  symbol: string | null;
  startTime: string | null;
  config: {
    takeProfitPercent: number;
    stopLossPercent: number;
    leverage: number;
  } | null;
}

// 滚仓记录
interface RollingRecord {
  id: number;
  time: Date;
  action: 'open' | 'roll' | 'close';
  price: number;
  margin: number;
  positionValue: number;
  pnl?: number;
  reason?: string;
}

// 滚仓状态
interface RollingState {
  isActive: boolean;
  direction: 'long' | 'short' | null;
  entryPrice: number | null;
  currentMargin: number;
  rollCount: number;
  totalPnl: number;
  records: RollingRecord[];
}

export default function RollingPage() {
  const { symbol } = useChartStore();
  const { user, token } = useUserStore();

  // 策略参数
  const [initialMargin, setInitialMargin] = useState(100);
  const [leverage, setLeverage] = useState(20);
  const [rollInterval, setRollInterval] = useState(2); // 每涨/跌 N% 滚仓
  const [rollProfitRatio, setRollProfitRatio] = useState(100); // 滚仓比例（浮盈的百分比）
  const [stopLossRatio, setStopLossRatio] = useState(50); // 止损比例（亏损保证金的百分比）
  const [takeProfitRatio, setTakeProfitRatio] = useState(300); // 止盈比例（盈利保证金的百分比）

  // 网格参数
  const [gridSpacing, setGridSpacing] = useState(1.0); // 网格间距 (USDT)
  const [gridCount, setGridCount] = useState(10); // 网格数量
  const [orderSize, setOrderSize] = useState(0.01); // 每单大小 (ETH)
  const [maxPosition, setMaxPosition] = useState(1); // 最大仓位 (ETH)

  // 目标价位停止滚仓
  const [targetPrice, setTargetPrice] = useState(0); // 目标价位 (0=不设置)
  const [stopRollDistance, setStopRollDistance] = useState(1); // 停止滚仓距离 (%)

  // 滚仓服务状态
  const [serviceStatus, setServiceStatus] = useState<RollingServiceStatus>({
    isRunning: false,
    direction: null,
    symbol: null,
    startTime: null,
    config: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // 获取服务状态
  const fetchServiceStatus = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/rolling', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setServiceStatus(data.data);
      }
    } catch (error) {
      console.error('获取滚仓状态失败:', error);
    }
  }, [token]);

  // 启动滚仓服务
  const startRollingService = async () => {
    if (!token) {
      setStatusMessage({ type: 'error', text: '请先登录' });
      return;
    }
    setIsLoading(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/rolling', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          symbol: symbol || 'ETHUSDC',
          leverage,
          gridSpacing,
          gridCount,
          orderSize,
          takeProfitPercent: takeProfitRatio / leverage, // 将保证金百分比转换为价格百分比
          stopLossPercent: stopLossRatio / leverage,
          useRollingMargin: rollProfitRatio > 0,
          rollProfitRatio,
          maxPosition,
          targetPrice: targetPrice || 0, // 目标价位 (0=不设置)
          stopRollDistance: stopRollDistance || 1, // 停止滚仓距离 (%)
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatusMessage({ type: 'success', text: data.message });
        fetchServiceStatus();
      } else {
        setStatusMessage({ type: 'error', text: data.error });
      }
    } catch (error) {
      setStatusMessage({ type: 'error', text: '启动失败: ' + (error instanceof Error ? error.message : '未知错误') });
    } finally {
      setIsLoading(false);
    }
  };

  // 停止滚仓服务
  const stopRollingService = async () => {
    if (!token) {
      setStatusMessage({ type: 'error', text: '请先登录' });
      return;
    }
    setIsLoading(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/rolling', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setStatusMessage({ type: 'success', text: data.message });
        fetchServiceStatus();
      } else {
        setStatusMessage({ type: 'error', text: data.error });
      }
    } catch (error) {
      setStatusMessage({ type: 'error', text: '停止失败: ' + (error instanceof Error ? error.message : '未知错误') });
    } finally {
      setIsLoading(false);
    }
  };

  // 滚仓状态
  const [rollingState, setRollingState] = useState<RollingState>({
    isActive: false,
    direction: null,
    entryPrice: null,
    currentMargin: 0,
    rollCount: 0,
    totalPnl: 0,
    records: [],
  });

  // 模拟计算
  const [simulation, setSimulation] = useState<{
    targetPrice: number;
    priceChange: number;
    rollTimes: number;
    finalMargin: number;
    finalPnl: number;
    pnlPercent: number;
  } | null>(null);

  // 从 localStorage 加载设置
  useEffect(() => {
    const saved = {
      initialMargin: localStorage.getItem(STORAGE_KEYS.INITIAL_MARGIN),
      leverage: localStorage.getItem(STORAGE_KEYS.LEVERAGE),
      rollInterval: localStorage.getItem(STORAGE_KEYS.ROLL_INTERVAL),
      rollProfitRatio: localStorage.getItem(STORAGE_KEYS.ROLL_PROFIT_RATIO),
      stopLossRatio: localStorage.getItem(STORAGE_KEYS.STOP_LOSS_RATIO),
      takeProfitRatio: localStorage.getItem(STORAGE_KEYS.TAKE_PROFIT_RATIO),
      gridSpacing: localStorage.getItem(STORAGE_KEYS.GRID_SPACING),
      gridCount: localStorage.getItem(STORAGE_KEYS.GRID_COUNT),
      orderSize: localStorage.getItem(STORAGE_KEYS.ORDER_SIZE),
      maxPosition: localStorage.getItem(STORAGE_KEYS.MAX_POSITION),
      targetPrice: localStorage.getItem(STORAGE_KEYS.TARGET_PRICE),
      stopRollDistance: localStorage.getItem(STORAGE_KEYS.STOP_ROLL_DISTANCE),
    };

    if (saved.initialMargin) setInitialMargin(Number(saved.initialMargin));
    if (saved.leverage) setLeverage(Number(saved.leverage));
    if (saved.rollInterval) setRollInterval(Number(saved.rollInterval));
    if (saved.rollProfitRatio) setRollProfitRatio(Number(saved.rollProfitRatio));
    if (saved.stopLossRatio) setStopLossRatio(Number(saved.stopLossRatio));
    if (saved.takeProfitRatio) setTakeProfitRatio(Number(saved.takeProfitRatio));
    if (saved.gridSpacing) setGridSpacing(Number(saved.gridSpacing));
    if (saved.gridCount) setGridCount(Number(saved.gridCount));
    if (saved.orderSize) setOrderSize(Number(saved.orderSize));
    if (saved.maxPosition) setMaxPosition(Number(saved.maxPosition));
    if (saved.targetPrice) setTargetPrice(Number(saved.targetPrice));
    if (saved.stopRollDistance) setStopRollDistance(Number(saved.stopRollDistance));

    // 获取滚仓服务状态
    fetchServiceStatus();

    // 定期轮询状态
    const interval = setInterval(fetchServiceStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchServiceStatus]);

  // 保存设置到 localStorage
  const saveToLocalStorage = useCallback((key: string, value: number) => {
    localStorage.setItem(key, String(value));
  }, []);

  // 计算滚仓模拟
  const calculateSimulation = useCallback((
    direction: 'long' | 'short',
    currentPrice: number,
    targetPriceInput: number
  ) => {
    const targetPrice = targetPriceInput;
    const priceChange = direction === 'long'
      ? ((targetPrice - currentPrice) / currentPrice) * 100
      : ((currentPrice - targetPrice) / currentPrice) * 100;

    if (priceChange <= 0) {
      setSimulation(null);
      return;
    }

    // 计算滚仓次数
    const rollTimes = Math.floor(priceChange / rollInterval);

    // 复利计算
    let margin = initialMargin;
    const rollRatio = rollProfitRatio / 100;

    for (let i = 0; i < rollTimes; i++) {
      // 每次滚仓的浮盈 = 当前保证金 × 杠杆 × 涨幅
      const profit = margin * leverage * (rollInterval / 100);
      // 滚入的金额 = 浮盈 × 滚仓比例
      margin += profit * rollRatio;
    }

    // 最后一段（不足一个 rollInterval 的部分）
    const remainingChange = priceChange - rollTimes * rollInterval;
    const finalProfit = margin * leverage * (remainingChange / 100);
    margin += finalProfit;

    const finalPnl = margin - initialMargin;
    const pnlPercent = (finalPnl / initialMargin) * 100;

    setSimulation({
      targetPrice,
      priceChange,
      rollTimes,
      finalMargin: margin,
      finalPnl,
      pnlPercent,
    });
  }, [initialMargin, leverage, rollInterval, rollProfitRatio]);

  // 模拟目标价格
  const [simDirection, setSimDirection] = useState<'long' | 'short'>('long');
  const [simTargetPrice, setSimTargetPrice] = useState(0);
  const [currentPrice, setCurrentPrice] = useState(0);

  // 获取当前价格（简化版，实际应该从 WebSocket 获取）
  useEffect(() => {
    // 模拟当前价格
    const price = symbol.includes('BTC') ? 100000 : symbol.includes('ETH') ? 3300 : 1000;
    setCurrentPrice(price);
    setSimTargetPrice(price * 1.1); // 默认目标 +10%
  }, [symbol]);

  // 当参数变化时重新计算
  useEffect(() => {
    if (currentPrice > 0 && simTargetPrice > 0) {
      calculateSimulation(simDirection, currentPrice, simTargetPrice);
    }
  }, [simDirection, currentPrice, simTargetPrice, calculateSimulation]);

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[var(--bg-primary)]">
        {/* Header */}
        <header className="border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
          <Link
            href="/"
            className="text-blue-400 hover:text-blue-300 text-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            返回交易
          </Link>

          <h1 className="text-lg font-medium text-[var(--text-primary)] flex items-center gap-2">
            <span>🎢</span>
            滚仓策略
            <span className="text-xs font-normal text-[var(--text-tertiary)]">
              {symbol}
            </span>
          </h1>

          <div className="w-16" /> {/* Spacer */}
        </header>

        {/* Main Content */}
        <main className="p-4 max-w-2xl mx-auto space-y-4">
          {/* 策略说明 */}
          <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
            <h3 className="text-sm font-medium text-blue-400 mb-2">滚仓策略原理</h3>
            <ul className="text-xs text-[var(--text-tertiary)] space-y-1">
              <li>• 价格朝有利方向移动时，将浮盈加入保证金</li>
              <li>• 保证金增加 → 持仓量增加 → 收益指数级增长</li>
              <li>• <span className="text-yellow-400">风险警告</span>：一次回调可能导致全部亏损</li>
            </ul>
          </div>

          {/* 参数设置 */}
          <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">参数设置</h3>

            <div className="grid grid-cols-2 gap-4">
              {/* 初始保证金 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">初始保证金 (U)</label>
                <input
                  type="number"
                  value={initialMargin}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setInitialMargin(v);
                    saveToLocalStorage(STORAGE_KEYS.INITIAL_MARGIN, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                  min={10}
                  step={10}
                />
              </div>

              {/* 杠杆 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">杠杆倍数</label>
                <select
                  value={leverage}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setLeverage(v);
                    saveToLocalStorage(STORAGE_KEYS.LEVERAGE, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                >
                  {[5, 10, 15, 20, 25, 30, 50, 75, 100].map(n => (
                    <option key={n} value={n}>{n}x</option>
                  ))}
                </select>
              </div>

              {/* 滚仓间隔 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">滚仓间隔 (%)</label>
                <select
                  value={rollInterval}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setRollInterval(v);
                    saveToLocalStorage(STORAGE_KEYS.ROLL_INTERVAL, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                >
                  {[0.5, 1, 1.5, 2, 2.5, 3, 4, 5].map(n => (
                    <option key={n} value={n}>每涨/跌 {n}%</option>
                  ))}
                </select>
              </div>

              {/* 滚仓比例 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">滚仓比例 (浮盈%)</label>
                <select
                  value={rollProfitRatio}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setRollProfitRatio(v);
                    saveToLocalStorage(STORAGE_KEYS.ROLL_PROFIT_RATIO, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                >
                  {[50, 60, 70, 80, 90, 100].map(n => (
                    <option key={n} value={n}>{n}% 浮盈滚入</option>
                  ))}
                </select>
              </div>

              {/* 止损比例 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">止损 (亏损保证金%)</label>
                <select
                  value={stopLossRatio}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setStopLossRatio(v);
                    saveToLocalStorage(STORAGE_KEYS.STOP_LOSS_RATIO, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                >
                  {[30, 40, 50, 60, 70, 80].map(n => (
                    <option key={n} value={n}>亏损 {n}% 止损</option>
                  ))}
                </select>
              </div>

              {/* 止盈比例 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">止盈 (盈利保证金%)</label>
                <select
                  value={takeProfitRatio}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setTakeProfitRatio(v);
                    saveToLocalStorage(STORAGE_KEYS.TAKE_PROFIT_RATIO, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                >
                  {[100, 150, 200, 300, 500, 1000].map(n => (
                    <option key={n} value={n}>盈利 {n}% 止盈</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* 收益模拟器 */}
          <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">收益模拟器</h3>

            <div className="grid grid-cols-3 gap-3 mb-4">
              {/* 方向选择 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">方向</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSimDirection('long')}
                    className={`flex-1 py-2 text-xs rounded transition-colors ${
                      simDirection === 'long'
                        ? 'bg-green-500 text-white'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-green-500/20'
                    }`}
                  >
                    做多
                  </button>
                  <button
                    onClick={() => setSimDirection('short')}
                    className={`flex-1 py-2 text-xs rounded transition-colors ${
                      simDirection === 'short'
                        ? 'bg-red-500 text-white'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-red-500/20'
                    }`}
                  >
                    做空
                  </button>
                </div>
              </div>

              {/* 当前价格 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">当前价格</label>
                <input
                  type="number"
                  value={currentPrice}
                  onChange={(e) => setCurrentPrice(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* 目标价格 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">目标价格</label>
                <input
                  type="number"
                  value={simTargetPrice}
                  onChange={(e) => setSimTargetPrice(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {/* 快捷设置 */}
            <div className="flex gap-2 mb-4">
              <span className="text-xs text-[var(--text-tertiary)]">快捷:</span>
              {[5, 10, 15, 20].map(pct => (
                <button
                  key={pct}
                  onClick={() => {
                    const target = simDirection === 'long'
                      ? currentPrice * (1 + pct / 100)
                      : currentPrice * (1 - pct / 100);
                    setSimTargetPrice(Math.round(target * 100) / 100);
                  }}
                  className="px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-blue-500/20 text-[var(--text-secondary)] rounded transition-colors"
                >
                  {simDirection === 'long' ? '+' : '-'}{pct}%
                </button>
              ))}
            </div>

            {/* 模拟结果 */}
            {simulation && (
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-[var(--text-tertiary)]">价格变化:</span>
                    <span className={`ml-2 font-medium ${simulation.priceChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {simulation.priceChange >= 0 ? '+' : ''}{simulation.priceChange.toFixed(2)}%
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">滚仓次数:</span>
                    <span className="ml-2 font-medium text-blue-400">{simulation.rollTimes} 次</span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">最终保证金:</span>
                    <span className="ml-2 font-medium text-[var(--text-primary)]">{simulation.finalMargin.toFixed(2)} U</span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">最终盈亏:</span>
                    <span className={`ml-2 font-bold ${simulation.finalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {simulation.finalPnl >= 0 ? '+' : ''}{simulation.finalPnl.toFixed(2)} U
                    </span>
                  </div>
                </div>

                <div className="mt-3 pt-3 border-t border-[var(--border)]">
                  <div className="text-center">
                    <span className="text-[var(--text-tertiary)]">收益率:</span>
                    <span className={`ml-2 text-2xl font-bold ${simulation.pnlPercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {simulation.pnlPercent >= 0 ? '+' : ''}{simulation.pnlPercent.toFixed(1)}%
                    </span>
                  </div>
                  <div className="text-center text-xs text-[var(--text-tertiary)] mt-1">
                    普通持仓收益: {(simulation.priceChange * leverage).toFixed(1)}% |
                    滚仓增益: {(simulation.pnlPercent - simulation.priceChange * leverage).toFixed(1)}%
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 风险计算 */}
          <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">风险计算</h3>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="p-3 bg-red-500/10 rounded-lg">
                <div className="text-xs text-red-400 mb-1">爆仓回调幅度</div>
                <div className="text-xl font-bold text-red-400">
                  -{(100 / leverage).toFixed(1)}%
                </div>
                <div className="text-xs text-[var(--text-tertiary)] mt-1">
                  {leverage}x 杠杆
                </div>
              </div>

              <div className="p-3 bg-yellow-500/10 rounded-lg">
                <div className="text-xs text-yellow-400 mb-1">止损触发价格</div>
                <div className="text-xl font-bold text-yellow-400">
                  {currentPrice > 0 ? (
                    simDirection === 'long'
                      ? (currentPrice * (1 - stopLossRatio / 100 / leverage)).toFixed(2)
                      : (currentPrice * (1 + stopLossRatio / 100 / leverage)).toFixed(2)
                  ) : '-'}
                </div>
                <div className="text-xs text-[var(--text-tertiary)] mt-1">
                  亏损 {stopLossRatio}% 保证金
                </div>
              </div>
            </div>
          </div>

          {/* 网格参数 */}
          <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">网格参数</h3>

            <div className="grid grid-cols-2 gap-4">
              {/* 网格间距 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">网格间距 (USDT)</label>
                <select
                  value={gridSpacing}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setGridSpacing(v);
                    saveToLocalStorage(STORAGE_KEYS.GRID_SPACING, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                >
                  {[0.5, 1, 2, 3, 5, 10].map(n => (
                    <option key={n} value={n}>{n} USDT</option>
                  ))}
                </select>
              </div>

              {/* 网格数量 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">网格数量</label>
                <select
                  value={gridCount}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setGridCount(v);
                    saveToLocalStorage(STORAGE_KEYS.GRID_COUNT, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                >
                  {[5, 10, 15, 20, 30].map(n => (
                    <option key={n} value={n}>{n} 格</option>
                  ))}
                </select>
              </div>

              {/* 每单大小 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">每单大小 (ETH)</label>
                <input
                  type="number"
                  value={orderSize}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setOrderSize(v);
                    saveToLocalStorage(STORAGE_KEYS.ORDER_SIZE, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                  min={0.001}
                  step={0.001}
                />
              </div>

              {/* 最大仓位 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">最大仓位 (ETH)</label>
                <input
                  type="number"
                  value={maxPosition}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setMaxPosition(v);
                    saveToLocalStorage(STORAGE_KEYS.MAX_POSITION, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                  min={0}
                  step={0.1}
                />
                <p className="text-xs text-[var(--text-tertiary)] mt-1">0=不限制</p>
              </div>
            </div>
          </div>

          {/* 目标价位设置 */}
          <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">目标价位（接近时停止滚仓）</h3>

            <div className="grid grid-cols-2 gap-4">
              {/* 目标价位 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">目标价位</label>
                <input
                  type="number"
                  value={targetPrice}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setTargetPrice(v);
                    saveToLocalStorage(STORAGE_KEYS.TARGET_PRICE, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                  min={0}
                  step={1}
                  placeholder="如 3300"
                />
                <p className="text-xs text-[var(--text-tertiary)] mt-1">0=不设置目标价</p>
              </div>

              {/* 停止滚仓距离 */}
              <div>
                <label className="text-xs text-[var(--text-tertiary)] block mb-1">停止滚仓距离 (%)</label>
                <select
                  value={stopRollDistance}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setStopRollDistance(v);
                    saveToLocalStorage(STORAGE_KEYS.STOP_ROLL_DISTANCE, v);
                  }}
                  className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                >
                  {[0.5, 1, 1.5, 2, 3, 5].map(n => (
                    <option key={n} value={n}>距目标 {n}%</option>
                  ))}
                </select>
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  {targetPrice > 0 && (
                    <>停止价: {(targetPrice * (1 - stopRollDistance / 100)).toFixed(2)} (多) / {(targetPrice * (1 + stopRollDistance / 100)).toFixed(2)} (空)</>
                  )}
                </p>
              </div>
            </div>

            {targetPrice > 0 && (
              <div className="mt-3 p-2 bg-yellow-500/10 rounded text-xs text-yellow-400">
                多头滚仓: 价格达到 {(targetPrice * (1 - stopRollDistance / 100)).toFixed(2)} 时停止补单
                <br />
                空头滚仓: 价格达到 {(targetPrice * (1 + stopRollDistance / 100)).toFixed(2)} 时停止补单
              </div>
            )}
          </div>

          {/* 滚仓服务状态 */}
          {serviceStatus.isRunning && (
            <div className={`p-4 rounded-lg border ${
              serviceStatus.direction === 'long'
                ? 'bg-green-500/10 border-green-500/30'
                : 'bg-red-500/10 border-red-500/30'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className={`text-sm font-medium ${
                  serviceStatus.direction === 'long' ? 'text-green-400' : 'text-red-400'
                }`}>
                  滚仓服务运行中
                </h3>
                <span className="px-2 py-1 text-xs rounded bg-black/30">
                  {serviceStatus.direction === 'long' ? '做多' : '做空'}
                </span>
              </div>
              <div className="text-xs text-[var(--text-tertiary)] space-y-1">
                <p>交易对: {serviceStatus.symbol}</p>
                <p>启动时间: {serviceStatus.startTime ? new Date(serviceStatus.startTime).toLocaleString() : '-'}</p>
                {serviceStatus.config && (
                  <>
                    <p>止盈: {serviceStatus.config.takeProfitPercent}% | 止损: {serviceStatus.config.stopLossPercent}%</p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* 状态消息 */}
          {statusMessage && (
            <div className={`p-3 rounded-lg text-sm ${
              statusMessage.type === 'success' ? 'bg-green-500/20 text-green-400' :
              statusMessage.type === 'error' ? 'bg-red-500/20 text-red-400' :
              'bg-blue-500/20 text-blue-400'
            }`}>
              {statusMessage.text}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">策略操作</h3>

            {serviceStatus.isRunning ? (
              <button
                onClick={stopRollingService}
                disabled={isLoading}
                className="w-full py-3 bg-gray-500 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
              >
                {isLoading ? '停止中...' : '停止滚仓服务'}
              </button>
            ) : (
              <div className="space-y-3">
                <button
                  onClick={startRollingService}
                  disabled={isLoading}
                  className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
                >
                  {isLoading ? '启动中...' : '开启滚仓服务'}
                </button>
                <p className="text-xs text-[var(--text-tertiary)] text-center">
                  自动检测当前持仓方向（需要先有单向持仓）
                </p>
              </div>
            )}
          </div>

          {/* 滚仓对比表 */}
          <details className="group">
            <summary className="p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] cursor-pointer list-none flex items-center justify-between hover:bg-[var(--bg-tertiary)] transition-colors">
              <span className="text-sm font-medium text-[var(--text-primary)]">
                滚仓 vs 普通持仓 对比表
              </span>
              <svg
                className="w-4 h-4 text-[var(--text-tertiary)] transition-transform group-open:rotate-180"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <div className="mt-2 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[var(--text-tertiary)]">
                    <th className="text-left py-2">涨幅</th>
                    <th className="text-right py-2">普通{leverage}x</th>
                    <th className="text-right py-2">滚仓{leverage}x</th>
                    <th className="text-right py-2">增益</th>
                  </tr>
                </thead>
                <tbody className="text-[var(--text-secondary)]">
                  {[2, 5, 10, 15, 20].map(pct => {
                    const normalPnl = pct * leverage;
                    const rollTimes = Math.floor(pct / rollInterval);
                    let margin = initialMargin;
                    for (let i = 0; i < rollTimes; i++) {
                      margin += margin * leverage * (rollInterval / 100) * (rollProfitRatio / 100);
                    }
                    const remaining = pct - rollTimes * rollInterval;
                    margin += margin * leverage * (remaining / 100);
                    const rollPnl = ((margin - initialMargin) / initialMargin) * 100;

                    return (
                      <tr key={pct} className="border-t border-[var(--border)]">
                        <td className="py-2 text-green-400">+{pct}%</td>
                        <td className="py-2 text-right">+{normalPnl}%</td>
                        <td className="py-2 text-right text-green-400">+{rollPnl.toFixed(0)}%</td>
                        <td className="py-2 text-right text-blue-400">+{(rollPnl - normalPnl).toFixed(0)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </main>

        {/* Footer */}
        <footer className="border-t border-[var(--border)] px-4 py-2 text-center">
          <p className="text-xs text-[var(--text-tertiary)]">
            滚仓策略 · 高风险高收益
          </p>
        </footer>
      </div>
    </AuthGuard>
  );
}
