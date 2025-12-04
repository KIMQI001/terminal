"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { IChartApi, ISeriesApi } from "lightweight-charts";
import { useOrderStore, groupOrders, RealOrder } from "@/stores/orderStore";
import { useChartStore } from "@/stores/chartStore";

interface OrderCancelOverlayProps {
  chartRef: React.RefObject<IChartApi | null>;
  seriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

interface ButtonPosition {
  groupIndex: number;
  y: number;
  group: RealOrder[];
}

export function OrderCancelOverlay({
  chartRef,
  seriesRef,
  containerRef,
}: OrderCancelOverlayProps) {
  const { realOrders, cancelOrder, fetchOpenOrders } = useOrderStore();
  const { symbol } = useChartStore();
  const [buttonPositions, setButtonPositions] = useState<ButtonPosition[]>([]);
  const [cancellingGroup, setCancellingGroup] = useState<number | null>(null);

  const currentSymbol = symbol.replace("/", "");

  // 过滤当前交易对的订单并分组
  const orderGroups = useMemo(() => {
    const filtered = realOrders.filter((o) => o.symbol === currentSymbol);
    return groupOrders(filtered);
  }, [realOrders, currentSymbol]);

  // 计算按钮位置
  const updatePositions = useCallback(() => {
    if (!seriesRef.current || !containerRef.current) return;

    const positions: ButtonPosition[] = [];

    orderGroups.forEach((group, groupIndex) => {
      // 找组内的限价单（入场价）
      const limitOrder = group.find(
        (o) => o.type.toLowerCase() === "limit" && o.price
      );
      if (!limitOrder || !limitOrder.price) return;

      // 获取价格对应的 Y 坐标
      const y = seriesRef.current!.priceToCoordinate(limitOrder.price);
      if (y === null) return;

      positions.push({
        groupIndex,
        y,
        group,
      });
    });

    setButtonPositions(positions);
  }, [orderGroups, seriesRef, containerRef]);

  // 监听图表滚动/缩放
  useEffect(() => {
    if (!chartRef.current) return;

    const chart = chartRef.current;

    // 订阅时间轴变化
    const handleTimeRangeChange = () => {
      updatePositions();
    };

    chart.timeScale().subscribeVisibleTimeRangeChange(handleTimeRangeChange);

    // 初始计算
    updatePositions();

    return () => {
      chart
        .timeScale()
        .unsubscribeVisibleTimeRangeChange(handleTimeRangeChange);
    };
  }, [chartRef, updatePositions]);

  // 订单变化时更新
  useEffect(() => {
    updatePositions();
  }, [orderGroups, updatePositions]);

  // 取消整组订单
  const handleCancelGroup = async (group: RealOrder[], groupIndex: number) => {
    setCancellingGroup(groupIndex);
    for (const order of group) {
      await cancelOrder(order.id, order.symbol);
    }
    fetchOpenOrders(symbol);
    setCancellingGroup(null);
  };

  if (buttonPositions.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-20">
      {buttonPositions.map(({ groupIndex, y, group }) => (
        <button
          key={groupIndex}
          className="absolute pointer-events-auto w-4 h-4 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-500/10 rounded transition-colors text-xs font-bold"
          style={{
            right: 72, // 价格轴宽度左侧
            top: y - 8,
          }}
          onClick={() => handleCancelGroup(group, groupIndex)}
          disabled={cancellingGroup === groupIndex}
          title="取消这组订单"
        >
          {cancellingGroup === groupIndex ? "..." : "×"}
        </button>
      ))}
    </div>
  );
}
