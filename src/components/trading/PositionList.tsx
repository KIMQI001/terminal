"use client";

import { Button } from "@/components/ui/button";
import { usePositionStore } from "@/stores/positionStore";

export function PositionList() {
  const { positions, closePosition } = usePositionStore();

  if (positions.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
        暂无持仓
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {positions.map((position) => (
        <div
          key={position.id}
          className="p-3 bg-[var(--bg-tertiary)] rounded-lg space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{position.symbol}</span>
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${
                  position.side === "long"
                    ? "bg-[var(--positive)]/10 text-[var(--positive)]"
                    : "bg-[var(--negative)]/10 text-[var(--negative)]"
                }`}
              >
                {position.side === "long" ? "多" : "空"}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={() => closePosition(position.id)}
            >
              平仓
            </Button>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-[var(--text-secondary)]">数量</div>
              <div>{position.quantity}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">均价</div>
              <div>{position.entryPrice.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">盈亏</div>
              <div
                className={
                  position.unrealizedPnl >= 0
                    ? "text-[var(--positive)]"
                    : "text-[var(--negative)]"
                }
              >
                {position.unrealizedPnl >= 0 ? "+" : ""}
                {position.unrealizedPnl.toFixed(2)}
                <span className="ml-1">
                  ({position.unrealizedPnlPercent >= 0 ? "+" : ""}
                  {position.unrealizedPnlPercent.toFixed(2)}%)
                </span>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
