"use client";

import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { usePositionStore } from "@/stores/positionStore";
import { useChartStore } from "@/stores/chartStore";

export function PositionList() {
  const {
    positions,
    isLoadingPositions,
    fetchPositions,
    closePosition,
    updatePositionSLTP,
    wsConnected,
    initUserWebSocket,
    disconnectUserWebSocket,
  } = usePositionStore();
  const { symbol } = useChartStore();
  const [closingId, setClosingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSL, setEditSL] = useState<string>("");
  const [editTP, setEditTP] = useState<string>("");
  const [savingSLTP, setSavingSLTP] = useState(false);
  const [sltpError, setSltpError] = useState<string | null>(null);
  const fallbackIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // 初始化 WebSocket 并获取初始持仓
  useEffect(() => {
    fetchPositions();
    initUserWebSocket();
    return () => {
      disconnectUserWebSocket();
    };
  }, [initUserWebSocket, disconnectUserWebSocket, fetchPositions]);

  // Fallback 轮询：当 WebSocket 断开时每 60 秒轮询一次
  useEffect(() => {
    if (!wsConnected) {
      fallbackIntervalRef.current = setInterval(() => {
        fetchPositions();
      }, 60000);
    } else {
      if (fallbackIntervalRef.current) {
        clearInterval(fallbackIntervalRef.current);
        fallbackIntervalRef.current = null;
      }
    }
    return () => {
      if (fallbackIntervalRef.current) {
        clearInterval(fallbackIntervalRef.current);
        fallbackIntervalRef.current = null;
      }
    };
  }, [wsConnected, fetchPositions]);

  // 过滤当前交易对的持仓
  const currentPositions = symbol
    ? positions.filter((p) => p.symbol === symbol.replace("/", ""))
    : positions;

  const handleClose = async (id: string) => {
    if (!confirm("确定要平仓吗？")) return;
    setClosingId(id);
    try {
      await closePosition(id);
    } finally {
      setClosingId(null);
    }
  };

  const startEdit = (position: (typeof positions)[number]) => {
    setEditingId(position.id);
    setEditSL(position.stopLoss ? String(position.stopLoss) : "");
    setEditTP(position.takeProfit ? String(position.takeProfit) : "");
    setSltpError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditSL("");
    setEditTP("");
    setSltpError(null);
  };

  const saveSLTP = async (position: (typeof positions)[number]) => {
    const sl = parseFloat(editSL);
    const tp = parseFloat(editTP);
    const slNum = !isNaN(sl) && sl > 0 ? sl : 0;
    const tpNum = !isNaN(tp) && tp > 0 ? tp : 0;

    // 两边都为空：不修改（空=保持当前或按入场价默认）
    if (slNum === 0 && tpNum === 0) {
      cancelEdit();
      return;
    }

    setSavingSLTP(true);
    setSltpError(null);
    try {
      const result = await updatePositionSLTP(
        position.symbol,
        (position.side === "long" ? "LONG" : "SHORT"),
        slNum,
        tpNum
      );
      if (result.success) {
        cancelEdit();
      } else {
        setSltpError(result.error || "保存失败");
      }
    } finally {
      setSavingSLTP(false);
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
      {currentPositions.map((position) => {
        const isEditing = editingId === position.id;
        return (
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

            {/* 止盈止损：可点击进入编辑 */}
            <div className="flex gap-3 text-xs pt-1 border-t border-[var(--border)] items-center">
              <div className="flex items-center gap-1 flex-1">
                <span className="text-[var(--text-secondary)] shrink-0">止损:</span>
                {isEditing ? (
                  <input
                    type="number"
                    value={editSL}
                    onChange={(e) => setEditSL(e.target.value)}
                    placeholder="止损价"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveSLTP(position);
                      if (e.key === "Escape") cancelEdit();
                    }}
                    className="w-full px-1 py-0.5 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded focus:outline-none focus:border-orange-500"
                  />
                ) : position.stopLoss ? (
                  <button
                    onClick={() => startEdit(position)}
                    className="text-[var(--negative)] hover:underline font-mono"
                  >
                    {position.stopLoss.toLocaleString()}
                  </button>
                ) : (
                  <button
                    onClick={() => startEdit(position)}
                    className="text-[var(--text-secondary)] hover:text-[var(--negative)] italic"
                    title="点击设置止损"
                  >
                    未设置
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1 flex-1">
                <span className="text-[var(--text-secondary)] shrink-0">止盈:</span>
                {isEditing ? (
                  <input
                    type="number"
                    value={editTP}
                    onChange={(e) => setEditTP(e.target.value)}
                    placeholder="止盈价"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveSLTP(position);
                      if (e.key === "Escape") cancelEdit();
                    }}
                    className="w-full px-1 py-0.5 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded focus:outline-none focus:border-green-500"
                  />
                ) : position.takeProfit ? (
                  <button
                    onClick={() => startEdit(position)}
                    className="text-[var(--positive)] hover:underline font-mono"
                  >
                    {position.takeProfit.toLocaleString()}
                  </button>
                ) : (
                  <button
                    onClick={() => startEdit(position)}
                    className="text-[var(--text-secondary)] hover:text-[var(--positive)] italic"
                    title="点击设置止盈"
                  >
                    未设置
                  </button>
                )}
              </div>
              {isEditing && (
                <div className="flex gap-1 shrink-0">
                  <Button
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => saveSLTP(position)}
                    disabled={savingSLTP}
                  >
                    {savingSLTP ? "..." : "保存"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs px-2"
                    onClick={cancelEdit}
                    disabled={savingSLTP}
                  >
                    ✕
                  </Button>
                </div>
              )}
            </div>
            {isEditing && sltpError && (
              <div className="text-[10px] text-red-500">⚠ {sltpError}</div>
            )}
            {isEditing && (
              <div className="text-[10px] text-gray-400">
                回车保存 · Esc 取消 · 留空=保持（无则按 ±200/±1000 默认）
              </div>
            )}

            {position.liquidationPrice && position.liquidationPrice > 0 && (
              <div className="text-xs text-[var(--text-secondary)]">
                强平价:{" "}
                <span className="text-[var(--negative)]">
                  {position.liquidationPrice.toLocaleString()}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
