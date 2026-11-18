"use client";

import { useEffect, useRef, useState } from "react";
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
  const [notice, setNotice] = useState<string | null>(null);
  // 提交后收起图上的草稿预览线(表单本身保留,可继续下单)
  const [draftOff, setDraftOff] = useState(false);
  // 用户手动改过止损/止盈 → 不再自动覆盖
  const slManual = useRef(false);
  const tpManual = useRef(false);

  const isReview = status === "review" || cursor < frontier;

  // 默认止损/止盈点数（入场价 ± N 点）
  const slPoints = config.defaultStopLossPoints ?? 0;
  const tpPoints = config.defaultTakeProfitPoints ?? 0;

  // 预填（面板点价位 / 双击图表）
  useEffect(() => {
    if (!prefill) return;
    setSide(prefill.side);
    setOrderType("limit");
    setPrice(String(prefill.entry));
    slManual.current = !!prefill.stopLoss;
    tpManual.current = !!prefill.takeProfit;
    setStopLoss(prefill.stopLoss ? String(prefill.stopLoss) : "");
    setTakeProfit(prefill.takeProfit ? String(prefill.takeProfit) : "");
    setError(null);
    setNotice(null);
    setDraftOff(false);
  }, [prefill]);

  // 市价单跟随现价
  useEffect(() => {
    if (orderType === "market" && lastPrice > 0) setPrice(String(lastPrice));
  }, [orderType, lastPrice]);

  // 自动填默认止损/止盈（入场价 ± 默认点数；用户手动改过就不再覆盖）
  const entryForDefault = orderType === "market" ? lastPrice : parseFloat(price) || 0;
  useEffect(() => {
    if (!(entryForDefault > 0)) return;
    if (!slManual.current) {
      setStopLoss(slPoints > 0 ? (entryForDefault + (side === "buy" ? -slPoints : slPoints)).toFixed(2) : "");
    }
    if (!tpManual.current) {
      setTakeProfit(tpPoints > 0 ? (entryForDefault + (side === "buy" ? tpPoints : -tpPoints)).toFixed(2) : "");
    }
  }, [entryForDefault, side, slPoints, tpPoints]);

  // 图上预览线（entry / SL / TP）
  useEffect(() => {
    const entry = orderType === "market" ? lastPrice : parseFloat(price) || 0;
    const sl = parseFloat(stopLoss) || 0;
    const tp = parseFloat(takeProfit) || 0;
    if (draftOff || !(entry > 0)) {
      setDraft(null);
      return;
    }
    setDraft({ side, entry, stopLoss: sl > 0 ? sl : undefined, takeProfit: tp > 0 ? tp : undefined });
  }, [price, stopLoss, takeProfit, side, orderType, lastPrice, setDraft, draftOff]);

  const qty = config.quantity;
  const entryPrice = orderType === "market" ? lastPrice : parseFloat(price) || 0;
  const notional = entryPrice * qty;
  const margin = notional / Math.max(1, config.leverage);

  const handleSubmit = () => {
    setError(null);
    setNotice(null);
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
    // 提交后保留入场价与 SL/TP(按钮保持可点,可继续下单),
    // 这样「止盈/止损后等待新单」时直接再点一次就是新的一单
    setPrefill(null);
    setDraftOff(true); // 收起图上的草稿预览线(挂单自己的价格线不受影响)
    setNotice("已提交模拟单，可继续下单");
  };

  // 改了方向/类型/价格 → 重新打开草稿预览线
  const touchForm = () => {
    setDraftOff(false);
    setNotice(null);
  };

  // 换方向 → 止损/止盈方向相反，重新按默认点数自动填
  const switchSide = (s: "buy" | "sell") => {
    touchForm();
    slManual.current = false;
    tpManual.current = false;
    setSide(s);
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
        <button className={btnCls(side === "buy", true)} onClick={() => switchSide("buy")}>
          开多 BUY
        </button>
        <button className={btnCls(side === "sell", false)} onClick={() => switchSide("sell")}>
          开空 SELL
        </button>
      </div>

      {/* 类型 */}
      <div className="flex gap-1 p-1 bg-[var(--bg-tertiary)] rounded-lg">
        <button className={btnCls(orderType === "limit", true)} onClick={() => { touchForm(); setOrderType("limit"); }}>
          限价
        </button>
        <button className={btnCls(orderType === "market", true)} onClick={() => { touchForm(); setOrderType("market"); }}>
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
          onChange={(e) => { touchForm(); setPrice(e.target.value); }}
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
          placeholder={slPoints > 0 ? `止损价格（默认 ${slPoints} 点）` : "止损价格（可留空）"}
          value={stopLoss}
          onChange={(e) => { touchForm(); slManual.current = true; setStopLoss(e.target.value); }}
          suffix="USDT"
        />
      </div>

      {/* 止盈 */}
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-secondary)]">止盈 (TP)</label>
        <Input
          data-testid="replay-sim-tp"
          type="number"
          placeholder={tpPoints > 0 ? `止盈价格（默认 ${tpPoints} 点）` : "止盈价格（可留空）"}
          value={takeProfit}
          onChange={(e) => { touchForm(); tpManual.current = true; setTakeProfit(e.target.value); }}
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

      {notice && !error && (
        <div className="text-xs text-green-600 bg-green-50 px-2 py-1.5 rounded" data-testid="replay-sim-notice">
          {notice}
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
