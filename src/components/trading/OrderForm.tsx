"use client";

import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore, TradingLine } from "@/stores/orderStore";
import { usePositionStore } from "@/stores/positionStore";
import { OrderType, OrderSide } from "@/types/order";

const orderTypes: { value: OrderType; label: string }[] = [
  { value: "limit", label: "限价" },
  { value: "market", label: "市价" },
];

export function OrderForm() {
  const { symbol, candles } = useChartStore();
  const { addOrder, closeModal, prefillData, setPrefillData, setTradingLines } = useOrderStore();
  const { getBalance } = usePositionStore();

  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [selectedSide, setSelectedSide] = useState<OrderSide | null>(null);
  const [price, setPrice] = useState<string>("");
  const [amountUSD, setAmountUSD] = useState<string>("");
  const [stopLoss, setStopLoss] = useState<string>("");
  const [takeProfit, setTakeProfit] = useState<string>("");

  const lastPrice = candles[candles.length - 1]?.close || 0;
  const baseAsset = symbol.replace("USDT", "").replace("USDC", "");

  // 根据交易对判断使用 USDC 还是 USDT
  const quoteAsset = symbol.endsWith("USDC") ? "USDC" : "USDT";
  const quoteBalance = getBalance(quoteAsset);

  // 监听prefillData变化，自动填充表单
  useEffect(() => {
    if (prefillData) {
      setOrderType("limit");
      setSelectedSide(prefillData.side);
      setPrice(prefillData.entry.toFixed(2));
      setStopLoss(prefillData.stopLoss.toFixed(2));
      setTakeProfit(prefillData.takeProfit.toFixed(2));
    }
  }, [prefillData]);

  // 监听价格输入变化，同步更新图表线条
  useEffect(() => {
    if (!selectedSide) return;

    const entry = parseFloat(price) || 0;
    const sl = parseFloat(stopLoss) || 0;
    const tp = parseFloat(takeProfit) || 0;

    // 入场价格清空时，清除所有线条
    if (entry <= 0) {
      setTradingLines([]);
      return;
    }

    const lines: TradingLine[] = [];
    lines.push({ price: entry, type: "entry", side: selectedSide });
    if (sl > 0) lines.push({ price: sl, type: "stopLoss", side: selectedSide });
    if (tp > 0) lines.push({ price: tp, type: "takeProfit", side: selectedSide });

    setTradingLines(lines);
  }, [price, stopLoss, takeProfit, selectedSide, setTradingLines]);

  // 计算币数量
  const coinQuantity = useMemo(() => {
    const p = orderType === "market" ? lastPrice : parseFloat(price) || 0;
    const usd = parseFloat(amountUSD) || 0;
    if (p <= 0) return 0;
    return usd / p;
  }, [orderType, price, amountUSD, lastPrice]);

  const handlePercentage = (percent: number) => {
    if (!quoteBalance) return;
    const maxUSD = (quoteBalance.free * percent) / 100;
    setAmountUSD(maxUSD.toFixed(2));
  };

  const handleSubmit = (side: OrderSide) => {
    const orderData = {
      type: orderType,
      side,
      price: orderType !== "market" ? parseFloat(price) : undefined,
      stopPrice: stopLoss ? parseFloat(stopLoss) : undefined,
      quantity: coinQuantity, // 使用计算出的币数量
    };

    addOrder(orderData, symbol);

    // Reset form
    setAmountUSD("");
    setStopLoss("");
    setTakeProfit("");
    setSelectedSide(null);
    setPrefillData(null);
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

      {/* 方向指示 (来自OTE) */}
      {selectedSide && (
        <div className={`text-xs font-medium px-2 py-1 rounded ${
          selectedSide === 'buy'
            ? 'bg-blue-100 text-blue-700'
            : 'bg-purple-100 text-purple-700'
        }`}>
          OTE {selectedSide === 'buy' ? '看涨 (BUY)' : '看跌 (SELL)'}
        </div>
      )}

      {/* 价格输入 */}
      {orderType !== "market" && (
        <div className="space-y-1.5">
          <label className="text-xs text-[var(--text-secondary)]">入场价格</label>
          <Input
            type="number"
            placeholder="入场价格"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            suffix="USDT"
          />
        </div>
      )}

      {/* 止损输入 */}
      <div className="space-y-1.5">
        <label className="text-xs text-[var(--text-secondary)]">止损 (SL)</label>
        <Input
          type="number"
          placeholder="止损价格"
          value={stopLoss}
          onChange={(e) => setStopLoss(e.target.value)}
          suffix="USDT"
        />
      </div>

      {/* 止盈输入 */}
      <div className="space-y-1.5">
        <label className="text-xs text-[var(--text-secondary)]">止盈 (TP)</label>
        <Input
          type="number"
          placeholder="止盈价格"
          value={takeProfit}
          onChange={(e) => setTakeProfit(e.target.value)}
          suffix="USDT"
        />
      </div>

      {/* 金额输入 */}
      <div className="space-y-1.5">
        <div className="flex justify-between">
          <label className="text-xs text-[var(--text-secondary)]">金额</label>
          <span className="text-xs text-[var(--text-secondary)]">
            可用: {quoteBalance?.free.toLocaleString() || 0} {quoteAsset}
          </span>
        </div>
        <Input
          type="number"
          placeholder="金额"
          value={amountUSD}
          onChange={(e) => setAmountUSD(e.target.value)}
          suffix={quoteAsset}
        />
        <div className="text-xs text-[var(--text-secondary)]">
          ≈ {coinQuantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} {baseAsset}
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
          disabled={!amountUSD || parseFloat(amountUSD) <= 0 || coinQuantity <= 0}
          className={`text-white ${
            selectedSide === 'buy'
              ? 'bg-blue-600 hover:bg-blue-700 ring-2 ring-blue-300'
              : 'bg-[var(--positive)] hover:bg-[var(--positive)]/90'
          }`}
        >
          买入 / 做多
        </Button>
        <Button
          onClick={() => handleSubmit("sell")}
          disabled={!amountUSD || parseFloat(amountUSD) <= 0 || coinQuantity <= 0}
          className={`text-white ${
            selectedSide === 'sell'
              ? 'bg-purple-600 hover:bg-purple-700 ring-2 ring-purple-300'
              : 'bg-[var(--negative)] hover:bg-[var(--negative)]/90'
          }`}
        >
          卖出 / 做空
        </Button>
      </div>
    </div>
  );
}
