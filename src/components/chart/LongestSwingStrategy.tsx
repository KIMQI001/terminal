"use client";

/**
 * 「最长波段」策略控制(仅 admin 可见,挂在 LongestSwingPanel 底部)
 *
 * 把面板上的 6 个价位变成自动挂单策略:
 * - 任意一个价位被触发 → 框架成立 → 给其余未触发的价位挂单
 * - 止 200 点 / 止盈 1000 点;一旦有持仓 → 撤掉其余挂单,只留止盈止损
 * - 下单量按余额比例(余额 × 保证金比例,平均分给每一档)
 *
 * 后端:Rust 服务 look-left-right(默认 127.0.0.1:3005),前端走 /api/look-left-right 代理。
 */

import { useCallback, useEffect, useState } from "react";
import { useChartStore } from "@/stores/chartStore";
import { useUserStore } from "@/stores/userStore";
import { cn } from "@/lib/utils";

interface StrategyStatus {
  state: "idle" | "waiting" | "armed" | "in_position" | "stopped";
  running: boolean;
  symbol: string;
  timeframe: string;
  exchange: string;
  user_id: number;
  dry_run: boolean;
  margin_pct: number;
  sl_points: number;
  tp_points: number;
  current_price: number | null;
  balance: number | null;
  leverage: number | null;
  orders: { client_order_id: string; label: string; price: number; side: string; quantity: number; order_type: string }[];
  position: { position_side: string; amount: number; entry_price: number; quantity: number } | null;
  /** hedge 模式下可能同时有多头和空头 */
  positions?: { position_side: string; amount: number; entry_price: number; quantity: number }[];
  last_error: string | null;
  updated_at: number;
}

const STATE_TEXT: Record<string, { text: string; cls: string }> = {
  idle: { text: "未启动", cls: "bg-gray-100 text-gray-500" },
  waiting: { text: "等待框架成立", cls: "bg-amber-100 text-amber-700" },
  armed: { text: "已挂单待成交", cls: "bg-blue-100 text-blue-700" },
  in_position: { text: "持仓中", cls: "bg-green-100 text-green-700" },
  stopped: { text: "已停止", cls: "bg-gray-100 text-gray-500" },
};

export function LongestSwingStrategy() {
  const { symbol, timeframe } = useChartStore();
  const activeExchange = useUserStore((s) => s.activeExchange);
  const token = useUserStore((s) => s.token);

  const [marginPct, setMarginPct] = useState(0.375);
  const [slPoints, setSlPoints] = useState(200);
  const [tpPoints, setTpPoints] = useState(1000);
  const [dryRun, setDryRun] = useState(true);
  const [status, setStatus] = useState<StrategyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsErr, setMsgIsErr] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/look-left-right/status", {
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!r.ok) return;
      const d = await r.json();
      setStatus(d as StrategyStatus);
    } catch {
      /* 服务没起来就静默 */
    }
  }, [token]);

  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 3000);
    return () => clearInterval(timer);
  }, [loadStatus]);

  const start = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/look-left-right/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          symbol,
          timeframe,
          exchange: activeExchange || "binance",
          margin_pct: marginPct,
          sl_points: slPoints,
          tp_points: tpPoints,
          dry_run: dryRun,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsgIsErr(true);
        setMsg(d?.error || `启动失败(${r.status})`);
      } else {
        setMsgIsErr(false);
        setMsg(dryRun ? "已启动(DRY RUN,不会真的下单)" : "已启动(真实下单)");
        setStatus(d as StrategyStatus);
      }
    } catch (e) {
      setMsgIsErr(true);
      setMsg("无法连接 look-left-right 服务");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/look-left-right/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ reason: "前端手动停止" }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setMsgIsErr(false);
        setMsg("已停止(入场挂单已撤)");
        setStatus(d as StrategyStatus);
      } else {
        setMsgIsErr(true);
        setMsg(d?.error || `停止失败(${r.status})`);
      }
    } catch {
      setMsgIsErr(true);
      setMsg("无法连接 look-left-right 服务");
    } finally {
      setBusy(false);
    }
  };

  const st = status ? STATE_TEXT[status.state] || STATE_TEXT.idle : null;
  const running = !!status?.running;

  return (
    <div className="mt-2 pt-2 border-t border-dashed border-gray-200 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-gray-600">框架策略</span>
        {st && (
          <span className={cn("px-1 rounded text-[9px] font-semibold", st.cls)}>{st.text}</span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1 text-[9px] font-mono text-gray-500">
        <label className="flex flex-col gap-0.5">
          <span>保证金比例</span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max="1"
            value={marginPct}
            onChange={(e) => setMarginPct(Number(e.target.value))}
            className="border border-gray-200 rounded px-1 py-0.5 text-[10px]"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span>止损点数</span>
          <input
            type="number"
            step="10"
            value={slPoints}
            onChange={(e) => setSlPoints(Number(e.target.value))}
            className="border border-gray-200 rounded px-1 py-0.5 text-[10px]"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span>止盈点数</span>
          <input
            type="number"
            step="10"
            value={tpPoints}
            onChange={(e) => setTpPoints(Number(e.target.value))}
            className="border border-gray-200 rounded px-1 py-0.5 text-[10px]"
          />
        </label>
      </div>

      <div className="flex items-center justify-between text-[9px] text-gray-500">
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          <span>DRY RUN(只算不发单)</span>
        </label>
        <span className="font-mono text-gray-400">
          {symbol} · {timeframe}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={start}
          disabled={busy}
          className={cn(
            "px-2 py-0.5 rounded text-[10px] font-semibold border",
            dryRun
              ? "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"
              : "bg-red-50 text-red-600 border-red-200 hover:bg-red-100",
            busy && "opacity-50 cursor-not-allowed"
          )}
        >
          {running ? "重新配置并启动" : "启动策略"}
        </button>
        <button
          onClick={stop}
          disabled={busy || !running}
          className={cn(
            "px-2 py-0.5 rounded text-[10px] font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50",
            (busy || !running) && "opacity-50 cursor-not-allowed"
          )}
        >
          停止
        </button>
        {status && (
          <span className="ml-auto text-[9px] font-mono text-gray-400">
            {status.current_price ? `价 ${status.current_price.toFixed(1)}` : ""}
            {status.balance != null ? ` · 余 ${status.balance.toFixed(2)}` : ""}
            {status.leverage ? ` · ${status.leverage}x` : ""}
          </span>
        )}
      </div>

      {(() => {
        // 多空两边都成交时两个持仓都要显示
        const posList =
          status?.positions && status.positions.length > 0
            ? status.positions
            : status?.position
              ? [status.position]
              : [];
        if (posList.length === 0) return null;
        return (
          <div className="text-[9px] font-mono text-green-700 space-y-0.5">
            {posList.map((p) => (
              <div key={p.position_side}>
                持仓 {p.position_side} {p.quantity} @ {p.entry_price.toFixed(1)}
              </div>
            ))}
          </div>
        );
      })()}
      {status && status.orders.length > 0 && (
        <div className="text-[9px] font-mono text-gray-500 space-y-0.5">
          {status.orders.map((o) => (
            <div key={o.client_order_id} className="flex items-center gap-1">
              <span className="text-gray-400">{o.label}</span>
              <span>{o.price.toFixed(1)}</span>
              <span className={o.side === "buy" ? "text-green-600" : "text-red-600"}>
                {o.side === "buy" ? "多" : "空"}
              </span>
              <span className="text-gray-400">
                {o.order_type} × {o.quantity}
              </span>
            </div>
          ))}
        </div>
      )}
      {status?.last_error && (
        <div className="text-[9px] font-mono text-red-600">错误:{status.last_error}</div>
      )}
      {msg && (
        <div
          className={cn(
            "text-[9px] font-mono",
            msgIsErr ? "text-red-600" : "text-gray-500"
          )}
        >
          {msg}
        </div>
      )}
    </div>
  );
}
