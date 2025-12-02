"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useOrderStore } from "@/stores/orderStore";

const orderTypeLabels: Record<string, string> = {
  limit: "限价",
  market: "市价",
  "stop-limit": "止损限价",
  "stop-market": "止损市价",
};

export function OpenOrderList() {
  const { getOpenOrders, cancelOrder } = useOrderStore();
  const openOrders = getOpenOrders();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = async (orderId: string, symbol: string) => {
    setCancellingId(orderId);
    await cancelOrder(orderId, symbol);
    setCancellingId(null);
  };

  if (openOrders.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
        暂无挂单
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {openOrders.map((order) => (
        <div
          key={order.id}
          className="p-3 bg-[var(--bg-tertiary)] rounded-lg space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{order.symbol}</span>
              <span className="text-xs text-[var(--text-secondary)]">
                {orderTypeLabels[order.type]}
              </span>
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${
                  order.side === "buy"
                    ? "bg-[var(--positive)]/10 text-[var(--positive)]"
                    : "bg-[var(--negative)]/10 text-[var(--negative)]"
                }`}
              >
                {order.side === "buy" ? "买" : "卖"}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              disabled={cancellingId === order.id}
              onClick={() => handleCancel(order.id, order.symbol)}
            >
              {cancellingId === order.id ? '取消中...' : '取消'}
            </Button>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-[var(--text-secondary)]">价格</div>
              <div>{order.price?.toLocaleString() || "-"}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">数量</div>
              <div>{order.quantity}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">已成交</div>
              <div>
                {order.filledQuantity} / {order.quantity}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
