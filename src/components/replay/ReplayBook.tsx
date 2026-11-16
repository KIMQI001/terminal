"use client";

import { Trash2 } from "lucide-react";
import { useReplayStore } from "@/stores/replayStore";

/** 模拟持仓列表 */
export function ReplayPositionsList() {
  const positions = useReplayStore((s) => s.view.positions);
  const markPrice = useReplayStore((s) => s.view.account.markPrice);
  const cursor = useReplayStore((s) => s.cursor);
  const frontier = useReplayStore((s) => s.frontier);
  const closeSimPosition = useReplayStore((s) => s.closeSimPosition);

  const isReview = cursor < frontier;

  if (positions.length === 0) {
    return <div className="text-[10px] text-gray-400 py-1 text-center">暂无持仓</div>;
  }

  return (
    <div className="space-y-1">
      {positions.map((p) => {
        const pnl = p.side === "buy" ? (markPrice - p.entryPrice) * p.quantity : (p.entryPrice - markPrice) * p.quantity;
        return (
          <div key={p.id} className="border border-gray-200 rounded p-1.5 space-y-0.5">
            <div className="flex items-center justify-between text-[10px]">
              <span className={p.side === "buy" ? "text-blue-600 font-semibold" : "text-purple-600 font-semibold"}>
                {p.side === "buy" ? "多" : "空"} {p.quantity}
              </span>
              <span className="font-mono">@{p.entryPrice.toFixed(2)}</span>
              <span className={`font-mono ${pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                {pnl >= 0 ? "+" : ""}
                {pnl.toFixed(2)}
              </span>
            </div>
            <div className="text-[10px] text-gray-400 font-mono">
              SL {p.stopLoss?.toFixed(2) ?? "-"} / TP {p.takeProfit?.toFixed(2) ?? "-"} · 保证金 {p.margin.toFixed(2)}
            </div>
            <button
              data-testid={`replay-close-pos-${p.id}`}
              className="w-full py-0.5 rounded bg-red-50 text-red-600 hover:bg-red-100 text-[10px] disabled:opacity-40"
              disabled={isReview}
              onClick={() => closeSimPosition(p.id)}
            >
              手动平仓
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** 模拟挂单列表 */
export function ReplayOrdersList() {
  const orders = useReplayStore((s) => s.view.orders);
  const cancelSimOrder = useReplayStore((s) => s.cancelSimOrder);

  const pending = orders.filter((o) => o.status === "pending");
  if (pending.length === 0) {
    return <div className="text-[10px] text-gray-400 py-1 text-center">暂无挂单</div>;
  }

  return (
    <div className="space-y-1">
      {pending.map((o) => (
        <div key={o.id} className="border border-gray-200 rounded p-1.5 flex items-center justify-between text-[10px]">
          <span className={o.side === "buy" ? "text-blue-600" : "text-purple-600"}>
            {o.side === "buy" ? "限价买" : "限价卖"} {o.price.toFixed(2)}
          </span>
          <span className="text-gray-400 font-mono">第 {o.eligibleFromBar} 根起</span>
          <button
            data-testid={`replay-cancel-order-${o.id}`}
            className="p-0.5 rounded hover:bg-red-50 text-red-500"
            onClick={() => cancelSimOrder(o.id)}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 模拟成交记录 */
export function ReplayFillsList() {
  const fills = useReplayStore((s) => s.view.fills);

  if (fills.length === 0) {
    return <div className="text-[10px] text-gray-400 py-1 text-center">暂无成交</div>;
  }

  return (
    <div className="space-y-0.5">
      {[...fills].reverse().map((f) => (
        <div key={f.id} className="flex items-center justify-between text-[10px] py-0.5 border-b border-gray-50">
          <span className="text-gray-400 font-mono">#{f.bar + 1}</span>
          <span className={f.kind === "entry" ? "text-blue-600" : "text-gray-700"}>
            {f.kind === "entry" ? "开仓" : "平仓"} {f.side === "buy" ? "买" : "卖"}
          </span>
          <span className="font-mono">{f.price.toFixed(2)}</span>
          <span className="text-gray-400">{f.reason ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

/** 持仓 + 挂单 + 成交(纵向堆叠) */
export function ReplayBook() {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-[11px] font-semibold text-gray-700 mb-1">模拟持仓</div>
        <ReplayPositionsList />
      </div>
      <div>
        <div className="text-[11px] font-semibold text-gray-700 mb-1">模拟挂单</div>
        <ReplayOrdersList />
      </div>
      <div>
        <div className="text-[11px] font-semibold text-gray-700 mb-1">成交记录</div>
        <ReplayFillsList />
      </div>
    </div>
  );
}
