"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrderStore } from "@/stores/orderStore";
import { useChartStore } from "@/stores/chartStore";
import { usePositionStore } from "@/stores/positionStore";
import { OrderForm } from "./OrderForm";
import { PositionList } from "./PositionList";
import { OpenOrderList } from "./OpenOrderList";

export function TradePanel() {
  const { isModalOpen, closeModal } = useOrderStore();
  const { symbol } = useChartStore();
  const { fetchBalances } = usePositionStore();

  // 面板打开时获取真实余额
  useEffect(() => {
    if (isModalOpen) {
      fetchBalances();
    }
  }, [isModalOpen, fetchBalances]);

  if (!isModalOpen) return null;

  return (
    <div className="w-80 h-full flex flex-col border-l border-[var(--border)] bg-[var(--bg-secondary)]">
      {/* 面板头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <h2 className="text-sm font-medium">交易 - {symbol}</h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={closeModal}
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* 下单表单 */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4">
          <OrderForm />
        </div>

        {/* 持仓/挂单 */}
        <div className="border-t border-[var(--border)]">
          <Tabs defaultValue="positions" className="w-full">
            <TabsList className="w-full grid grid-cols-2 rounded-none bg-[var(--bg-tertiary)]">
              <TabsTrigger value="positions" className="text-xs">持仓</TabsTrigger>
              <TabsTrigger value="orders" className="text-xs">挂单</TabsTrigger>
            </TabsList>
            <div className="p-3">
              <TabsContent value="positions" className="mt-0 max-h-64 overflow-y-auto">
                <PositionList />
              </TabsContent>
              <TabsContent value="orders" className="mt-0 max-h-64 overflow-y-auto">
                <OpenOrderList />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
