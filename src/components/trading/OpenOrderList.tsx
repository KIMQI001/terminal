"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useOrderStore, RealOrder, groupOrders } from "@/stores/orderStore";
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
  const [cancellingGroup, setCancellingGroup] = useState<number | null>(null);

  // 分组订单 - 必须在所有条件返回之前
  const orderGroups = useMemo(() => groupOrders(realOrders), [realOrders]);

  // 获取真实挂单 + 5秒轮询
  useEffect(() => {
    if (!symbol) return;

    fetchOpenOrders(symbol);

    const interval = setInterval(() => {
      fetchOpenOrders(symbol);
    }, 5000);

    return () => clearInterval(interval);
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

  // 取消整组订单
  const handleCancelGroup = async (group: RealOrder[], groupIndex: number) => {
    setCancellingGroup(groupIndex);
    for (const order of group) {
      await cancelOrder(order.id, order.symbol);
    }
    fetchOpenOrders(symbol);
    setCancellingGroup(null);
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

  if (isLoadingOrders && realOrders.length === 0) {
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
    <div className="space-y-3">
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

      {orderGroups.map((group, groupIndex) => {
        const firstOrder = group[0];
        if (!firstOrder) return null;

        return (
          <div
            key={groupIndex}
            className="border border-[var(--border)] rounded-lg overflow-hidden"
          >
            {/* 组头：显示交易对、方向、数量 */}
            <div className="px-3 py-1.5 bg-[var(--bg-secondary)] flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium">{firstOrder.symbol}</span>
                <span className={`px-1.5 py-0.5 rounded ${
                  firstOrder.positionSide === 'LONG'
                    ? 'bg-blue-100 text-blue-600'
                    : 'bg-purple-100 text-purple-600'
                }`}>
                  {firstOrder.positionSide === 'LONG' ? '做多' : '做空'}
                </span>
                <span className="text-[var(--text-secondary)]">
                  {firstOrder.quantity} | {new Date(firstOrder.time).toLocaleTimeString()}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 px-2"
                disabled={cancellingGroup === groupIndex}
                onClick={() => handleCancelGroup(group, groupIndex)}
              >
                {cancellingGroup === groupIndex ? '取消中...' : '取消组'}
              </Button>
            </div>

          {/* 组内订单 */}
          <div className="divide-y divide-[var(--border)]">
            {group.map((order) => (
              <div
                key={order.id}
                className="px-3 py-2 flex items-center justify-between bg-[var(--bg-tertiary)]"
              >
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-1.5 py-0.5 rounded min-w-[40px] text-center ${
                    order.type.includes('stop')
                      ? 'bg-red-100 text-red-600'
                      : order.type.includes('profit')
                      ? 'bg-green-100 text-green-600'
                      : 'bg-gray-100 text-gray-600'
                  }`}>
                    {orderTypeLabels[order.type] || order.type}
                  </span>
                  <span className="text-sm font-mono">
                    {(order.stopPrice || order.price)?.toLocaleString() || "-"}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-gray-500 hover:text-red-500"
                  disabled={cancellingId === order.id}
                  onClick={() => handleCancel(order.id, order.symbol)}
                >
                  {cancellingId === order.id ? '...' : '×'}
                </Button>
              </div>
            ))}
          </div>
        </div>
        );
      })}
    </div>
  );
}
