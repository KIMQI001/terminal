"use client";

import { TowerBlock } from "./types";

interface TowerCardProps {
  block: TowerBlock;
  onOrder?: (block: TowerBlock) => void;
}

export function TowerCard({ block, onOrder }: TowerCardProps) {
  const isBearish = block.type === "bearish";
  const bgColor = isBearish ? "bg-red-500/5" : "bg-green-500/5";
  const borderColor = isBearish ? "border-red-500/20" : "border-green-500/20";

  const formatPrice = (price: number) => {
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
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
      className={`${bgColor} ${borderColor} border rounded-lg px-2.5 py-1.5 flex items-center gap-2 hover:scale-[1.005] transition-transform`}
    >
      {/* 指示器 + 周期 + 类型 */}
      <div className="flex items-center gap-1.5 min-w-[70px]">
        <span className="text-xs">{isBearish ? "🔴" : "🟢"}</span>
        <span className="text-[10px] font-medium text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] px-1 py-0.5 rounded">
          {block.timeframe.toUpperCase()}
        </span>
        <span className={`text-xs font-semibold ${
          block.source === "OTE" ? "text-yellow-400" : (isBearish ? "text-red-400" : "text-green-400")
        }`}>
          {block.source}
        </span>
      </div>

      {/* 入场价 */}
      <div className="flex-1 text-center">
        <span className="text-xs text-[var(--text-tertiary)]">入场 </span>
        <span className="text-xs font-mono font-medium text-[var(--text-primary)]">
          {formatPrice(block.entry)}
        </span>
      </div>

      {/* 止损 */}
      <div className="text-center min-w-[65px]">
        <span className="text-xs text-[var(--text-tertiary)]">损 </span>
        <span className="text-xs font-mono text-red-400">
          {formatPrice(block.stopLoss)}
        </span>
      </div>

      {/* 止盈 */}
      <div className="text-center min-w-[65px]">
        <span className="text-xs text-[var(--text-tertiary)]">盈 </span>
        <span className="text-xs font-mono text-green-400">
          {formatPrice(block.takeProfit)}
        </span>
      </div>

      {/* Fill Percent */}
      <div className="text-xs text-[var(--text-tertiary)] min-w-[35px] text-right">
        F:{block.fillPercent.toFixed(0)}
      </div>

      {/* RR */}
      <div className={`text-xs font-bold ${riskRewardColor} min-w-[30px] text-right`}>
        {block.riskReward.toFixed(1)}
      </div>

      {/* 下单按钮 */}
      {onOrder && (
        <button
          onClick={() => onOrder(block)}
          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
            isBearish
              ? "bg-red-500/20 hover:bg-red-500/30 text-red-400"
              : "bg-green-500/20 hover:bg-green-500/30 text-green-400"
          }`}
        >
          {isBearish ? "空" : "多"}
        </button>
      )}
    </div>
  );
}
