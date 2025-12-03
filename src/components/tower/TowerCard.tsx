"use client";

import { TowerBlock } from "./types";

interface TowerCardProps {
  block: TowerBlock;
  onOrder?: (block: TowerBlock) => void;
}

export function TowerCard({ block, onOrder }: TowerCardProps) {
  const isBearish = block.type === "bearish";
  const typeColor = isBearish ? "text-red-500" : "text-green-500";
  const bgColor = isBearish ? "bg-red-500/5" : "bg-green-500/5";
  const borderColor = isBearish ? "border-red-500/20" : "border-green-500/20";

  const formatPrice = (price: number) => {
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const riskRewardColor =
    block.riskReward >= 3
      ? "text-green-400"
      : block.riskReward >= 2
      ? "text-yellow-400"
      : "text-red-400";

  return (
    <div
      className={`${bgColor} ${borderColor} border rounded-lg p-3 transition-all hover:scale-[1.01]`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${typeColor}`}>
            {isBearish ? "🔴" : "🟢"}
          </span>
          <span className="text-xs font-medium text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">
            {block.timeframe.toUpperCase()}
          </span>
          <span className={`text-sm font-semibold ${typeColor}`}>
            {block.source}
          </span>
        </div>
        <div className="text-xs text-[var(--text-tertiary)]">
          {block.fillPercent.toFixed(0)}% filled
        </div>
      </div>

      {/* Price Zone */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-[var(--text-tertiary)]">
          ${formatPrice(block.low)} - ${formatPrice(block.high)}
        </div>
        <div className={`text-sm font-bold ${riskRewardColor}`}>
          RR: {block.riskReward.toFixed(1)}
        </div>
      </div>

      {/* Entry / SL / TP */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-[var(--text-tertiary)]">
            {isBearish ? "入场做空" : "入场做多"}
          </div>
          <div className="font-medium text-[var(--text-primary)]">
            ${formatPrice(block.entry)}
          </div>
        </div>
        <div>
          <div className="text-[var(--text-tertiary)]">止损</div>
          <div className="font-medium text-red-400">
            ${formatPrice(block.stopLoss)}
          </div>
        </div>
        <div>
          <div className="text-[var(--text-tertiary)]">止盈</div>
          <div className="font-medium text-green-400">
            ${formatPrice(block.takeProfit)}
          </div>
        </div>
      </div>

      {/* Order Button */}
      {onOrder && (
        <button
          onClick={() => onOrder(block)}
          className={`w-full mt-3 py-2 rounded-lg text-sm font-medium transition-all ${
            isBearish
              ? "bg-red-500/20 hover:bg-red-500/30 text-red-400 hover:text-red-300"
              : "bg-green-500/20 hover:bg-green-500/30 text-green-400 hover:text-green-300"
          }`}
        >
          {isBearish ? "做空" : "做多"}
        </button>
      )}
    </div>
  );
}
