"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore } from "@/stores/orderStore";
import { usePositionStore } from "@/stores/positionStore";
import { OrderType, OrderSide } from "@/types/order";

const orderTypes: { value: OrderType; label: string }[] = [
  { value: "limit", label: "限价" },
  { value: "market", label: "市价" },
];

export function OrderForm() {
  const { symbol, candles } = useChartStore();
  const { addOrder, closeModal } = useOrderStore();
  const { getBalance } = usePositionStore();

  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [price, setPrice] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("");

  const lastPrice = candles[candles.length - 1]?.close || 0;
  const baseAsset = symbol.replace("USDT", "");
  const usdtBalance = getBalance("USDT");

  const totalValue = useMemo(() => {
    const p = orderType === "market" ? lastPrice : parseFloat(price) || 0;
    const q = parseFloat(quantity) || 0;
    return p * q;
  }, [orderType, price, quantity, lastPrice]);

  const handlePercentage = (percent: number) => {
    if (!usdtBalance) return;
    const p = orderType === "market" ? lastPrice : parseFloat(price) || lastPrice;
    if (p <= 0) return;
    const maxQty = (usdtBalance.free * percent) / 100 / p;
    setQuantity(maxQty.toFixed(6));
  };

  const handleSubmit = (side: OrderSide) => {
    const orderData = {
      type: orderType,
      side,
      price: orderType !== "market" ? parseFloat(price) : undefined,
      quantity: parseFloat(quantity),
    };

    addOrder(orderData, symbol);

    // Reset form
    setQuantity("");
  };

  return (
    <div className="space-y-4">
      {/* 订单类型选择 */}
      <div className="flex gap-1 p-1 bg-[var(--bg-tertiary)] rounded-lg">
        {orderTypes.map((type) => (
          <button
            key={type.value}
            onClick={() => setOrderType(type.value)}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
              orderType === type.value
                ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {type.label}
          </button>
        ))}
      </div>

      {/* 价格输入 */}
      {orderType !== "market" && (
        <div className="space-y-1.5">
          <label className="text-xs text-[var(--text-secondary)]">价格</label>
          <Input
            type="number"
            placeholder="价格"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            suffix="USDT"
          />
        </div>
      )}

      {/* 数量输入 */}
      <div className="space-y-1.5">
        <div className="flex justify-between">
          <label className="text-xs text-[var(--text-secondary)]">数量</label>
          <span className="text-xs text-[var(--text-secondary)]">
            可用: {usdtBalance?.free.toLocaleString() || 0} USDT
          </span>
        </div>
        <Input
          type="number"
          placeholder="数量"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          suffix={baseAsset}
        />
        <div className="text-xs text-[var(--text-secondary)]">
          ≈ {totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
        </div>
        <div className="flex gap-1">
          {[25, 50, 75, 100].map((percent) => (
            <button
              key={percent}
              onClick={() => handlePercentage(percent)}
              className="flex-1 py-1 text-xs bg-[var(--bg-tertiary)] rounded hover:bg-[var(--border)] transition-colors"
            >
              {percent}%
            </button>
          ))}
        </div>
      </div>

      {/* 买入/卖出按钮 */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          onClick={() => handleSubmit("buy")}
          disabled={!quantity || parseFloat(quantity) <= 0}
          className="bg-[var(--positive)] hover:bg-[var(--positive)]/90 text-white"
        >
          买入 / 做多
        </Button>
        <Button
          onClick={() => handleSubmit("sell")}
          disabled={!quantity || parseFloat(quantity) <= 0}
          className="bg-[var(--negative)] hover:bg-[var(--negative)]/90 text-white"
        >
          卖出 / 做空
        </Button>
      </div>
    </div>
  );
}
