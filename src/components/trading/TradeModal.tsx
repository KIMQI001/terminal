"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrderStore } from "@/stores/orderStore";
import { useChartStore } from "@/stores/chartStore";
import { OrderForm } from "./OrderForm";
import { PositionList } from "./PositionList";
import { OpenOrderList } from "./OpenOrderList";
import { OrderHistory } from "./OrderHistory";

export function TradeModal() {
  const { isModalOpen, closeModal } = useOrderStore();
  const { symbol } = useChartStore();

  return (
    <Dialog open={isModalOpen} onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-medium">
            交易 - {symbol}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* 下单表单 */}
          <OrderForm />

          {/* 持仓/挂单/历史 */}
          <Tabs defaultValue="positions" className="w-full">
            <TabsList className="w-full grid grid-cols-3">
              <TabsTrigger value="positions">持仓</TabsTrigger>
              <TabsTrigger value="orders">挂单</TabsTrigger>
              <TabsTrigger value="history">历史</TabsTrigger>
            </TabsList>
            <TabsContent value="positions" className="max-h-48 overflow-y-auto">
              <PositionList />
            </TabsContent>
            <TabsContent value="orders" className="max-h-48 overflow-y-auto">
              <OpenOrderList />
            </TabsContent>
            <TabsContent value="history" className="max-h-48 overflow-y-auto">
              <OrderHistory />
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
