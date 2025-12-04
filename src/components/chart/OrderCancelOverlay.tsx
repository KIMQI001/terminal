"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
  isLong: boolean; // 用于确定颜色
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
  const rafRef = useRef<number | null>(null);

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
        isLong: limitOrder.positionSide === "LONG",
      });
    });

    setButtonPositions(positions);
  }, [orderGroups, seriesRef, containerRef]);

  // 使用 requestAnimationFrame 持续更新位置（处理价格轴缩放）
  useEffect(() => {
    const tick = () => {
      updatePositions();
      rafRef.current = requestAnimationFrame(tick);
    };

    // 延迟启动，确保图表已初始化
    const timer = setTimeout(() => {
      tick();
    }, 500);

    return () => {
      clearTimeout(timer);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [updatePositions]);

  // 订单变化时立即更新
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
      {buttonPositions.map(({ groupIndex, y, group, isLong }) => (
        <button
          key={groupIndex}
          className="absolute pointer-events-auto h-5 px-1 flex items-center justify-center text-white/70 hover:text-white transition-colors text-xs font-medium rounded-sm"
          style={{
            left: 140, // 价格标签宽度约 130px，放在其右侧
            top: y - 10,
            backgroundColor: isLong ? "#3b82f6" : "#a855f7", // 蓝色(做多) / 紫色(做空)
          }}
          onClick={() => handleCancelGroup(group, groupIndex)}
          disabled={cancellingGroup === groupIndex}
          title="取消这组订单"
        >
          {cancellingGroup === groupIndex ? "···" : "×"}
        </button>
      ))}
    </div>
  );
}
