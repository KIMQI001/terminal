"use client";

import { useState, useEffect, useMemo } from "react";
import { TowerBlock } from "./types";
import { useOrderStore } from "@/stores/orderStore";
import { usePositionStore } from "@/stores/positionStore";
import { useChartStore } from "@/stores/chartStore";

// localStorage key for base margin
const STORAGE_KEY_BASE_MARGIN = "tower_base_margin";

interface TowerOrderModalProps {
  block: TowerBlock;
  onClose: () => void;
  defaultMargin?: number;
}

export function TowerOrderModal({ block, onClose, defaultMargin }: TowerOrderModalProps) {
  const { placeOrder, isPlacingOrder, orderError } = useOrderStore();
  const { currentLeverage, fetchLeverage } = usePositionStore();
  const { symbol } = useChartStore();

  // 使用传入的默认值，或从 localStorage 读取，或使用 100
  const getInitialMargin = () => {
    if (defaultMargin !== undefined) return String(defaultMargin);
    const saved = localStorage.getItem(STORAGE_KEY_BASE_MARGIN);
    return saved || "100";
  };

  const [marginAmount, setMarginAmount] = useState<string>(getInitialMargin);
  const [orderSuccess, setOrderSuccess] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [orderWarnings, setOrderWarnings] = useState<string[]>([]);

  // 获取当前杠杆
  useEffect(() => {
    fetchLeverage(symbol);
  }, [symbol, fetchLeverage]);

  // 计算开仓数量
  const quantity = useMemo(() => {
    const margin = parseFloat(marginAmount) || 0;
    if (margin <= 0 || block.entry <= 0) return 0;
    return (margin * currentLeverage) / block.entry;
  }, [marginAmount, currentLeverage, block.entry]);

  // 计算风险金额
  const riskAmount = useMemo(() => {
    const margin = parseFloat(marginAmount) || 0;
    const slDistance = Math.abs(block.entry - block.stopLoss);
    const slPercent = (slDistance / block.entry) * currentLeverage * 100;
    return (margin * slPercent) / 100;
  }, [marginAmount, currentLeverage, block.entry, block.stopLoss]);

  const formatPrice = (price: number) => {
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const handleSubmit = async () => {
    setLocalError(null);

    const margin = parseFloat(marginAmount);
    if (isNaN(margin) || margin <= 0) {
      setLocalError("请输入有效的保证金金额");
      return;
    }

    if (quantity <= 0) {
      setLocalError("开仓数量计算错误");
      return;
    }

    // 下单（使用和托管一致的 ict_tower 格式）
    const priceStr = Math.round(block.entry).toString();
    const result = await placeOrder(
      {
        type: "limit",
        side: block.type === "bullish" ? "buy" : "sell",
        price: block.entry,
        stopPrice: block.stopLoss,
        takeProfit: block.takeProfit,
        quantity: quantity,
        clientOrderIdPrefix: `ict_tower_${block.timeframe}_${block.source}_${priceStr}`,
      },
      symbol
    );

    if (result.success) {
      setOrderSuccess(true);
      // 保存警告信息（止盈止损失败等）
      if (result.warnings?.length) {
        setOrderWarnings(result.warnings);
      }
      setTimeout(() => {
        onClose();
      }, 2000);
    } else {
      setLocalError(result.error || "下单失败");
    }
  };

  const isBullish = block.type === "bullish";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-sm mx-4 bg-[var(--bg-secondary)] rounded-xl border border-[var(--border)] shadow-2xl overflow-hidden">
        {/* Header */}
        <div
          className={`px-4 py-3 border-b border-[var(--border)] ${
            isBullish ? "bg-green-500/10" : "bg-red-500/10"
          }`}
        >
          <div className="flex items-center justify-between">
            <h3
              className={`font-semibold ${
                isBullish ? "text-green-400" : "text-red-400"
              }`}
            >
              确认下单 - {isBullish ? "做多" : "做空"}
            </h3>
            <button
              onClick={onClose}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <div className="text-xs text-[var(--text-tertiary)] mt-1">
            {block.source} @ {block.timeframe}
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Order Details */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-[var(--bg-tertiary)] rounded-lg p-3">
              <div className="text-xs text-[var(--text-tertiary)]">入场价</div>
              <div className="font-mono font-medium text-[var(--text-primary)]">
                ${formatPrice(block.entry)}
              </div>
            </div>
            <div className="bg-[var(--bg-tertiary)] rounded-lg p-3">
              <div className="text-xs text-[var(--text-tertiary)]">止损价</div>
              <div className="font-mono font-medium text-red-400">
                ${formatPrice(block.stopLoss)}
              </div>
            </div>
            <div className="bg-[var(--bg-tertiary)] rounded-lg p-3">
              <div className="text-xs text-[var(--text-tertiary)]">止盈价</div>
              <div className="font-mono font-medium text-green-400">
                ${formatPrice(block.takeProfit)}
              </div>
            </div>
            <div className="bg-[var(--bg-tertiary)] rounded-lg p-3">
              <div className="text-xs text-[var(--text-tertiary)]">盈亏比</div>
              <div
                className={`font-mono font-medium ${
                  block.riskReward >= 2 ? "text-green-400" : "text-yellow-400"
                }`}
              >
                1:{block.riskReward.toFixed(1)}
              </div>
            </div>
          </div>

          {/* Margin Input */}
          <div>
            <label className="block text-xs text-[var(--text-tertiary)] mb-2">
              保证金 (USDT)
            </label>
            <div className="relative">
              <input
                type="number"
                value={marginAmount}
                onChange={(e) => setMarginAmount(e.target.value)}
                className="w-full px-4 py-3 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] font-mono focus:outline-none focus:border-blue-500"
                placeholder="100"
                min="1"
                step="10"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--text-tertiary)]">
                USDT
              </div>
            </div>
          </div>

          {/* Calculated Values */}
          <div className="bg-[var(--bg-tertiary)] rounded-lg p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">杠杆</span>
              <span className="font-mono text-[var(--text-primary)]">
                {currentLeverage}x
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">开仓数量</span>
              <span className="font-mono text-[var(--text-primary)]">
                {quantity.toFixed(6)} {symbol.replace("USDC", "")}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">风险金额</span>
              <span className="font-mono text-red-400">
                ${riskAmount.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Error Message */}
          {(localError || orderError) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-400">{localError || orderError}</p>
            </div>
          )}

          {/* Success Message */}
          {orderSuccess && (
            <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
              <p className="text-sm text-green-400">下单成功！</p>
              {orderWarnings.length > 0 && (
                <div className="mt-2 text-xs text-yellow-400">
                  {orderWarnings.map((w, i) => (
                    <p key={i}>⚠️ {w}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[var(--border)] flex gap-3">
          <button
            onClick={onClose}
            disabled={isPlacingOrder}
            className="flex-1 px-4 py-2.5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded-lg hover:bg-[var(--bg-primary)] transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={isPlacingOrder || orderSuccess}
            className={`flex-1 px-4 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50 ${
              isBullish
                ? "bg-green-500 hover:bg-green-600 text-white"
                : "bg-red-500 hover:bg-red-600 text-white"
            }`}
          >
            {isPlacingOrder ? (
              <span className="flex items-center justify-center gap-2">
                <svg
                  className="w-4 h-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                下单中...
              </span>
            ) : (
              "确认下单"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
