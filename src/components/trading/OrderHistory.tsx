"use client";

import { useOrderStore } from "@/stores/orderStore";

const orderTypeLabels: Record<string, string> = {
  limit: "限价",
  market: "市价",
  "stop-limit": "止损限价",
  "stop-market": "止损市价",
};

const statusLabels: Record<string, string> = {
  filled: "已成交",
  cancelled: "已取消",
  pending: "待成交",
  partial: "部分成交",
};

export function OrderHistory() {
  const { getOrderHistory } = useOrderStore();
  const history = getOrderHistory();

  if (history.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
        暂无历史订单
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {history.map((order) => (
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
            <span
              className={`text-xs ${
                order.status === "filled"
                  ? "text-[var(--positive)]"
                  : "text-[var(--text-secondary)]"
              }`}
            >
              {statusLabels[order.status]}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-[var(--text-secondary)]">价格</div>
              <div>{order.price?.toLocaleString() || "市价"}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">数量</div>
              <div>{order.quantity}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">时间</div>
              <div>
                {new Date(order.createdAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
