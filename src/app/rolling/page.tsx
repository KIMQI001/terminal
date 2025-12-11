"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { useUserStore } from "@/stores/userStore";

// 支持的交易对配置
const SUPPORTED_SYMBOLS = [
  { symbol: 'ETHUSDC', baseAsset: 'ETH', pricePrecision: 2, quantityPrecision: 3 },
  { symbol: 'BTCUSDC', baseAsset: 'BTC', pricePrecision: 2, quantityPrecision: 3 },
];

// localStorage keys
const STORAGE_KEYS = {
  SYMBOL: "rolling_symbol",
  LEVERAGE: "rolling_leverage",
  GRID_SPACING: "rolling_grid_spacing",
  GRID_COUNT: "rolling_grid_count",
  ORDER_SIZE: "rolling_order_size",
  MAX_POSITION: "rolling_max_position",
  TAKE_PROFIT: "rolling_take_profit",
  STOP_LOSS: "rolling_stop_loss",
  ROLL_PROFIT_RATIO: "rolling_profit_ratio",
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

export default function RollingPage() {
  const { token } = useUserStore();

  // 交易对选择
  const [selectedSymbol, setSelectedSymbol] = useState('ETHUSDC');
  const symbolConfig = SUPPORTED_SYMBOLS.find(s => s.symbol === selectedSymbol) || SUPPORTED_SYMBOLS[0];

  // 核心参数
  const [leverage, setLeverage] = useState(20);
  const [gridSpacing, setGridSpacing] = useState(1.0);
  const [gridCount, setGridCount] = useState(10);
  const [orderSize, setOrderSize] = useState(0.01);
  const [maxPosition, setMaxPosition] = useState(1);
  const [takeProfit, setTakeProfit] = useState(5);
  const [stopLoss, setStopLoss] = useState(3);
  const [rollProfitRatio, setRollProfitRatio] = useState(80);
  const [targetPrice, setTargetPrice] = useState(0);
  const [stopRollDistance, setStopRollDistance] = useState(1);

  // 服务状态
  const [serviceStatus, setServiceStatus] = useState<RollingServiceStatus>({
    isRunning: false,
    direction: null,
    symbol: null,
    startTime: null,
    config: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

  // 启动服务
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
          symbol: selectedSymbol,
          leverage,
          gridSpacing,
          gridCount,
          orderSize,
          takeProfitPercent: takeProfit,
          stopLossPercent: stopLoss,
          useRollingMargin: rollProfitRatio > 0,
          rollProfitRatio,
          maxPosition,
          targetPrice,
          stopRollDistance,
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

  // 停止服务
  const stopRollingService = async () => {
    if (!token) return;
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
      setStatusMessage({ type: 'error', text: '停止失败' });
    } finally {
      setIsLoading(false);
    }
  };

  // 加载设置
  useEffect(() => {
    // 加载交易对
    const savedSymbol = localStorage.getItem(STORAGE_KEYS.SYMBOL);
    if (savedSymbol && SUPPORTED_SYMBOLS.some(s => s.symbol === savedSymbol)) {
      setSelectedSymbol(savedSymbol);
    }

    const load = (key: string, setter: (v: number) => void) => {
      const v = localStorage.getItem(key);
      if (v) setter(Number(v));
    };
    load(STORAGE_KEYS.LEVERAGE, setLeverage);
    load(STORAGE_KEYS.GRID_SPACING, setGridSpacing);
    load(STORAGE_KEYS.GRID_COUNT, setGridCount);
    load(STORAGE_KEYS.ORDER_SIZE, setOrderSize);
    load(STORAGE_KEYS.MAX_POSITION, setMaxPosition);
    load(STORAGE_KEYS.TAKE_PROFIT, setTakeProfit);
    load(STORAGE_KEYS.STOP_LOSS, setStopLoss);
    load(STORAGE_KEYS.ROLL_PROFIT_RATIO, setRollProfitRatio);
    load(STORAGE_KEYS.TARGET_PRICE, setTargetPrice);
    load(STORAGE_KEYS.STOP_ROLL_DISTANCE, setStopRollDistance);

    fetchServiceStatus();
    const interval = setInterval(fetchServiceStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchServiceStatus]);

  // 保存设置
  const save = (key: string, value: number) => localStorage.setItem(key, String(value));

  const inputClass = "w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-blue-500";
  const labelClass = "text-xs text-[var(--text-tertiary)] block mb-1";

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[var(--bg-primary)]">
        {/* Header */}
        <header className="border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
          <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm">
            &larr; 返回
          </Link>
          <h1 className="text-lg font-medium text-[var(--text-primary)]">
            滚仓策略
          </h1>
          <select
            value={selectedSymbol}
            onChange={(e) => {
              setSelectedSymbol(e.target.value);
              localStorage.setItem(STORAGE_KEYS.SYMBOL, e.target.value);
            }}
            disabled={serviceStatus.isRunning}
            className="px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none disabled:opacity-50"
          >
            {SUPPORTED_SYMBOLS.map(s => (
              <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
            ))}
          </select>
        </header>

        <main className="p-4 max-w-lg mx-auto space-y-4">
          {/* 服务状态 */}
          {serviceStatus.isRunning && (
            <div className={`p-3 rounded-lg border ${
              serviceStatus.direction === 'long'
                ? 'bg-green-500/10 border-green-500/30 text-green-400'
                : 'bg-red-500/10 border-red-500/30 text-red-400'
            }`}>
              <div className="flex items-center justify-between text-sm font-medium">
                <span>服务运行中</span>
                <span>{serviceStatus.direction === 'long' ? '做多' : '做空'}</span>
              </div>
              <div className="text-xs mt-1 opacity-70">
                {serviceStatus.symbol} | 启动: {serviceStatus.startTime ? new Date(serviceStatus.startTime).toLocaleTimeString() : '-'}
              </div>
            </div>
          )}

          {/* 状态消息 */}
          {statusMessage && (
            <div className={`p-2 rounded text-sm ${
              statusMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
            }`}>
              {statusMessage.text}
            </div>
          )}

          {/* 基础参数 */}
          <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">基础参数</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>杠杆</label>
                <select value={leverage} onChange={(e) => { const v = Number(e.target.value); setLeverage(v); save(STORAGE_KEYS.LEVERAGE, v); }} className={inputClass}>
                  {[10, 15, 20, 25, 30, 50].map(n => <option key={n} value={n}>{n}x</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass}>滚仓比例</label>
                <select value={rollProfitRatio} onChange={(e) => { const v = Number(e.target.value); setRollProfitRatio(v); save(STORAGE_KEYS.ROLL_PROFIT_RATIO, v); }} className={inputClass}>
                  {[0, 50, 60, 70, 80, 90, 100].map(n => <option key={n} value={n}>{n === 0 ? '不滚仓' : `${n}%`}</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass}>止盈 %</label>
                <select value={takeProfit} onChange={(e) => { const v = Number(e.target.value); setTakeProfit(v); save(STORAGE_KEYS.TAKE_PROFIT, v); }} className={inputClass}>
                  {[3, 5, 8, 10, 15, 20].map(n => <option key={n} value={n}>{n}%</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass}>止损 %</label>
                <select value={stopLoss} onChange={(e) => { const v = Number(e.target.value); setStopLoss(v); save(STORAGE_KEYS.STOP_LOSS, v); }} className={inputClass}>
                  {[0, 2, 3, 5, 8, 10].map(n => <option key={n} value={n}>{n === 0 ? '不止损' : `${n}%`}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* 网格参数 */}
          <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">网格参数</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>间距 (USDT)</label>
                <select value={gridSpacing} onChange={(e) => { const v = Number(e.target.value); setGridSpacing(v); save(STORAGE_KEYS.GRID_SPACING, v); }} className={inputClass}>
                  {[0.5, 1, 2, 3, 5, 10].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass}>数量</label>
                <select value={gridCount} onChange={(e) => { const v = Number(e.target.value); setGridCount(v); save(STORAGE_KEYS.GRID_COUNT, v); }} className={inputClass}>
                  {[5, 10, 15, 20, 30].map(n => <option key={n} value={n}>{n}格</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass}>每单 ({symbolConfig.baseAsset})</label>
                <input type="number" value={orderSize} onChange={(e) => { const v = Number(e.target.value); setOrderSize(v); save(STORAGE_KEYS.ORDER_SIZE, v); }} className={inputClass} min={0.001} step={0.001} />
              </div>
              <div>
                <label className={labelClass}>最大仓位 ({symbolConfig.baseAsset})</label>
                <input type="number" value={maxPosition} onChange={(e) => { const v = Number(e.target.value); setMaxPosition(v); save(STORAGE_KEYS.MAX_POSITION, v); }} className={inputClass} min={0} step={0.1} />
              </div>
            </div>
          </div>

          {/* 目标价位 */}
          <div className="p-4 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3">目标价位 <span className="text-xs text-[var(--text-tertiary)] font-normal">接近时停止补单</span></h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>目标价</label>
                <input type="number" value={targetPrice} onChange={(e) => { const v = Number(e.target.value); setTargetPrice(v); save(STORAGE_KEYS.TARGET_PRICE, v); }} className={inputClass} placeholder="0=不设置" />
              </div>
              <div>
                <label className={labelClass}>停止距离</label>
                <select value={stopRollDistance} onChange={(e) => { const v = Number(e.target.value); setStopRollDistance(v); save(STORAGE_KEYS.STOP_ROLL_DISTANCE, v); }} className={inputClass}>
                  {[0.5, 1, 1.5, 2, 3, 5].map(n => <option key={n} value={n}>{n}%</option>)}
                </select>
              </div>
            </div>
            {targetPrice > 0 && (
              <p className="text-xs text-yellow-400 mt-2">
                停止价: {(targetPrice * (1 - stopRollDistance / 100)).toFixed(2)} (多) / {(targetPrice * (1 + stopRollDistance / 100)).toFixed(2)} (空)
              </p>
            )}
          </div>

          {/* 操作按钮 */}
          <div className="pt-2">
            {serviceStatus.isRunning ? (
              <button
                onClick={stopRollingService}
                disabled={isLoading}
                className="w-full py-3 bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white font-medium rounded-lg"
              >
                {isLoading ? '停止中...' : '停止滚仓'}
              </button>
            ) : (
              <button
                onClick={startRollingService}
                disabled={isLoading}
                className="w-full py-3 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white font-medium rounded-lg"
              >
                {isLoading ? '启动中...' : '开启滚仓'}
              </button>
            )}
            <p className="text-xs text-[var(--text-tertiary)] text-center mt-2">
              自动检测持仓方向（需先开仓）
            </p>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
