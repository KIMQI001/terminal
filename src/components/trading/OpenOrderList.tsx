"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useOrderStore, RealOrder } from "@/stores/orderStore";
import { useChartStore } from "@/stores/chartStore";

const orderTypeLabels: Record<string, string> = {
  limit: "限价",
  market: "市价",
  "stop-market": "止损",
  "stop_market": "止损",
  "take-profit-market": "止盈",
  "take-profit_market": "止盈",
  "stop-limit": "止损限价",
  "stop_limit": "止损限价",
};

export function OpenOrderList() {
  const { realOrders, isLoadingOrders, fetchOpenOrders, cancelOrder, cancelAllOrders } = useOrderStore();
  const { symbol } = useChartStore();
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [isCancellingAll, setIsCancellingAll] = useState(false);

  // 获取真实挂单
  useEffect(() => {
    if (symbol) {
      fetchOpenOrders(symbol);
    }
  }, [symbol, fetchOpenOrders]);

  const handleCancel = async (orderId: string, orderSymbol: string) => {
    setCancellingId(orderId);
    const success = await cancelOrder(orderId, orderSymbol);
    if (success) {
      // 刷新挂单列表
      fetchOpenOrders(symbol);
    }
    setCancellingId(null);
  };

  const handleRefresh = () => {
    fetchOpenOrders(symbol);
  };

  const handleCancelAll = async () => {
    if (!confirm('确定取消所有挂单吗？')) return;
    setIsCancellingAll(true);
    const success = await cancelAllOrders(symbol);
    if (success) {
      fetchOpenOrders(symbol);
    }
    setIsCancellingAll(false);
  };

  if (isLoadingOrders) {
    return (
      <div className="py-8 text-center text-sm text-[var(--text-secondary)]">
        加载中...
      </div>
    );
  }

  if (realOrders.length === 0) {
    return (
      <div className="py-4 text-center">
        <div className="text-sm text-[var(--text-secondary)] mb-2">暂无挂单</div>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          刷新
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end gap-2 mb-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs text-red-500 hover:text-red-600 hover:border-red-300"
          onClick={handleCancelAll}
          disabled={isCancellingAll || realOrders.length === 0}
        >
          {isCancellingAll ? '取消中...' : '全部取消'}
        </Button>
        <Button variant="outline" size="sm" className="h-6 text-xs" onClick={handleRefresh}>
          刷新
        </Button>
      </div>
      {realOrders.map((order: RealOrder) => (
        <div
          key={order.id}
          className="p-3 bg-[var(--bg-tertiary)] rounded-lg space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{order.symbol}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${
                order.type === 'stop-market'
                  ? 'bg-red-100 text-red-600'
                  : order.type === 'take-profit-market'
                  ? 'bg-green-100 text-green-600'
                  : 'bg-gray-100 text-gray-600'
              }`}>
                {orderTypeLabels[order.type] || order.type}
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
              <span className="text-xs text-gray-400">
                {order.positionSide === 'LONG' ? '多' : '空'}
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
              <div className="text-[var(--text-secondary)]">
                {order.stopPrice ? '触发价' : '价格'}
              </div>
              <div>{(order.stopPrice || order.price)?.toLocaleString() || "-"}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">数量</div>
              <div>{order.quantity}</div>
            </div>
            <div>
              <div className="text-[var(--text-secondary)]">时间</div>
              <div>{new Date(order.time).toLocaleTimeString()}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
