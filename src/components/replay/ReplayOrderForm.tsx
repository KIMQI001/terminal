"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useReplayStore } from "@/stores/replayStore";
import { useChartStore } from "@/stores/chartStore";

/**
 * 回放模拟下单表单
 * - 真实下单在回放期间被硬拦截，这里只走模拟撮合
 * - 预填来源：OTE/FVG/OB/最长波段/日K 面板点价位、双击图表
 */
export function ReplayOrderForm() {
  const candles = useChartStore((s) => s.candles);
  const prefill = useReplayStore((s) => s.prefill);
  const status = useReplayStore((s) => s.status);
  const cursor = useReplayStore((s) => s.cursor);
  const frontier = useReplayStore((s) => s.frontier);
  const config = useReplayStore((s) => s.config);
  const view = useReplayStore((s) => s.view);
  const placeSimOrder = useReplayStore((s) => s.placeSimOrder);
  const setPrefill = useReplayStore((s) => s.setPrefill);
  const setDraft = useReplayStore((s) => s.setDraft);

  const lastPrice = candles[candles.length - 1]?.close || 0;

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isReview = status === "review" || cursor < frontier;

  // 预填（面板点价位 / 双击图表）
  useEffect(() => {
    if (!prefill) return;
    setSide(prefill.side);
    setOrderType("limit");
    setPrice(String(prefill.entry));
    setStopLoss(prefill.stopLoss ? String(prefill.stopLoss) : "");
    setTakeProfit(prefill.takeProfit ? String(prefill.takeProfit) : "");
    setError(null);
  }, [prefill]);

  // 市价单跟随现价
  useEffect(() => {
    if (orderType === "market" && lastPrice > 0) setPrice(String(lastPrice));
  }, [orderType, lastPrice]);

  // 图上预览线（entry / SL / TP）
  useEffect(() => {
    const entry = orderType === "market" ? lastPrice : parseFloat(price) || 0;
    const sl = parseFloat(stopLoss) || 0;
    const tp = parseFloat(takeProfit) || 0;
    if (!(entry > 0)) {
      setDraft(null);
      return;
    }
    setDraft({ side, entry, stopLoss: sl > 0 ? sl : undefined, takeProfit: tp > 0 ? tp : undefined });
  }, [price, stopLoss, takeProfit, side, orderType, lastPrice, setDraft]);

  const qty = config.quantity;
  const entryPrice = orderType === "market" ? lastPrice : parseFloat(price) || 0;
  const notional = entryPrice * qty;
  const margin = notional / Math.max(1, config.leverage);

  const handleSubmit = () => {
    setError(null);
    const sl = parseFloat(stopLoss) || undefined;
    const tp = parseFloat(takeProfit) || undefined;
    const res = placeSimOrder({
      side,
      type: orderType,
      price: orderType === "limit" ? parseFloat(price) || undefined : undefined,
      quantity: qty,
      stopLoss: sl,
      takeProfit: tp,
    });
    if (!res.ok) {
      setError(res.error ?? "下单失败");
      return;
    }
    setPrefill(null);
    setDraft(null);
    setPrice("");
    setStopLoss("");
    setTakeProfit("");
  };

  const btnCls = (active: boolean, buy: boolean) =>
    `flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
      active
        ? buy
          ? "bg-blue-600 text-white"
          : "bg-purple-600 text-white"
        : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    }`;

  return (
    <div className="space-y-3" data-testid="replay-order-form">
      {isReview && (
        <div className="text-xs bg-amber-50 text-amber-700 px-2 py-1.5 rounded">
          回看模式：请先点「跳到最新」再下单
        </div>
      )}

      {/* 方向 */}
      <div className="flex gap-1 p-1 bg-[var(--bg-tertiary)] rounded-lg">
        <button className={btnCls(side === "buy", true)} onClick={() => setSide("buy")}>
          开多 BUY
        </button>
        <button className={btnCls(side === "sell", false)} onClick={() => setSide("sell")}>
          开空 SELL
        </button>
      </div>

      {/* 类型 */}
      <div className="flex gap-1 p-1 bg-[var(--bg-tertiary)] rounded-lg">
        <button className={btnCls(orderType === "limit", true)} onClick={() => setOrderType("limit")}>
          限价
        </button>
        <button className={btnCls(orderType === "market", true)} onClick={() => setOrderType("market")}>
          市价
        </button>
      </div>

      {/* 价格 */}
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-secondary)]">入场价格</label>
        <Input
          data-testid="replay-sim-price"
          type="number"
          placeholder={lastPrice ? String(lastPrice.toFixed(2)) : "入场价格"}
          value={orderType === "market" ? lastPrice.toFixed(2) : price}
          disabled={orderType === "market"}
          onChange={(e) => setPrice(e.target.value)}
          suffix="USDT"
        />
        {orderType === "limit" && lastPrice > 0 && (
          <div className="text-[10px] text-gray-400">
            当前价 {lastPrice.toFixed(2)}（限价{side === "buy" ? "买" : "卖"}须{side === "buy" ? "低" : "高"}于现价）
          </div>
        )}
      </div>

      {/* 止损 */}
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-secondary)]">止损 (SL)</label>
        <Input
          data-testid="replay-sim-sl"
          type="number"
          placeholder="止损价格（可留空）"
          value={stopLoss}
          onChange={(e) => setStopLoss(e.target.value)}
          suffix="USDT"
        />
      </div>

      {/* 止盈 */}
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-secondary)]">止盈 (TP)</label>
        <Input
          data-testid="replay-sim-tp"
          type="number"
          placeholder="止盈价格（可留空）"
          value={takeProfit}
          onChange={(e) => setTakeProfit(e.target.value)}
          suffix="USDT"
        />
      </div>

      {/* 仓位信息 */}
      <div className="text-[10px] text-gray-500 space-y-0.5 font-mono">
        <div>数量 {qty}（固定手数）· 杠杆 {config.leverage}x</div>
        <div>
          名义 {notional.toFixed(2)} USDT · 保证金 {margin.toFixed(2)} USDT · 可用{" "}
          {view.account.cashFree.toFixed(2)} USDT
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-500 bg-red-50 px-2 py-1.5 rounded" data-testid="replay-sim-error">
          {error}
        </div>
      )}

      <Button
        data-testid="replay-sim-submit"
        className="w-full"
        disabled={isReview || !(entryPrice > 0)}
        onClick={handleSubmit}
      >
        提交模拟单
      </Button>

      <div className="text-[10px] text-gray-400 leading-relaxed">
        模拟规则：下单最早在下一根 K 生效；市价单按下一根开盘价成交，限价单触及即成交；
        同一根 K 内止损优先；跳空不给优惠。
      </div>
    </div>
  );
}
