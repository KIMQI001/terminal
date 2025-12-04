"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePositionStore } from "@/stores/positionStore";
import { useChartStore } from "@/stores/chartStore";

export function PositionList() {
  const { positions, isLoadingPositions, fetchPositions, closePosition } = usePositionStore();
  const { symbol } = useChartStore();
  const [closingId, setClosingId] = useState<string | null>(null);

  // 获取真实持仓 + 3秒轮询
  useEffect(() => {
    fetchPositions();

    const interval = setInterval(() => {
      fetchPositions();
    }, 3000);

    return () => clearInterval(interval);
  }, [fetchPositions]);

  // 过滤当前交易对的持仓
  const currentPositions = symbol
    ? positions.filter(p => p.symbol === symbol.replace('/', ''))
    : positions;

  const handleClose = async (id: string) => {
    setClosingId(id);
    try {
      await closePosition(id);
    } finally {
      setClosingId(null);
    }
  };

  if (isLoadingPositions && positions.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
        加载中...
      </div>
    );
  }

  if (currentPositions.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
        暂无持仓
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {currentPositions.map((position) => (
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
              {position.leverage && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700">
                  {position.leverage}x
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={() => handleClose(position.id)}
              disabled={closingId === position.id}
            >
              {closingId === position.id ? "平仓中..." : "平仓"}
            </Button>
          </div>

          <div className="grid grid-cols-4 gap-2 text-xs">
            <div>
              <div className="text-[var(--text-secondary)]">数量</div>
              <div>{position.quantity}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">均价</div>
              <div>{position.entryPrice.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">标记</div>
              <div>{position.currentPrice.toLocaleString()}</div>
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
              </div>
            </div>
          </div>

          {/* 止盈止损信息 */}
          <div className="flex gap-4 text-xs pt-1 border-t border-[var(--border)]">
            <div className="flex items-center gap-1">
              <span className="text-[var(--text-secondary)]">止损:</span>
              {position.stopLoss ? (
                <span className="text-[var(--negative)]">{position.stopLoss.toLocaleString()}</span>
              ) : (
                <span className="text-[var(--text-secondary)]">未设置</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[var(--text-secondary)]">止盈:</span>
              {position.takeProfit ? (
                <span className="text-[var(--positive)]">{position.takeProfit.toLocaleString()}</span>
              ) : (
                <span className="text-[var(--text-secondary)]">未设置</span>
              )}
            </div>
          </div>

          {position.liquidationPrice && position.liquidationPrice > 0 && (
            <div className="text-xs text-[var(--text-secondary)]">
              强平价: <span className="text-[var(--negative)]">{position.liquidationPrice.toLocaleString()}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
