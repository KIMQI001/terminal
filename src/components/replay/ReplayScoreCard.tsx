"use client";

import { useState } from "react";
import { useReplayStore } from "@/stores/replayStore";
import type { ReplayScore, ReplayTrade } from "@/lib/replay/types";

const GRADE_COLOR: Record<string, string> = {
  "A+": "text-emerald-600",
  A: "text-green-600",
  B: "text-blue-600",
  C: "text-amber-600",
  D: "text-orange-600",
  E: "text-red-600",
};

function fmtTime(sec: number): string {
  if (!sec) return "-";
  return new Date(sec * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TradeRow({ t }: { t: ReplayTrade }) {
  const [open, setOpen] = useState(false);
  const reasonText =
    t.exitReason === "sl" ? "止损" : t.exitReason === "tp" ? "止盈" : t.exitReason === "manual" ? "手动平仓" : t.exitReason === "end" ? "结束强平" : "-";

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button className="w-full text-left px-2 py-1.5 hover:bg-gray-50" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-mono text-gray-500">#{t.seq}</span>
          <span className={t.side === "buy" ? "text-blue-600 font-semibold" : "text-purple-600 font-semibold"}>
            {t.side === "buy" ? "BUY" : "SELL"} {t.quantity}
          </span>
          <span className={t.pnl >= 0 ? "text-green-600 font-mono" : "text-red-600 font-mono"}>
            {t.pnl >= 0 ? "+" : ""}
            {t.pnl.toFixed(2)} ({t.pnlPct.toFixed(1)}%)
          </span>
          <span className="text-gray-400">{reasonText}</span>
        </div>
        <div className="text-[10px] text-gray-400 font-mono mt-0.5">
          {t.entryPrice.toFixed(2)} → {t.exitPrice?.toFixed(2) ?? "-"} · R {t.rMultiple.toFixed(2)}
          {t.entryScore != null && ` · 进场 ${t.entryScore}`}
        </div>
      </button>

      {open && (
        <div className="px-2 pb-2 text-[10px] text-gray-500 space-y-0.5 bg-gray-50/60">
          <div>开仓 {fmtTime(t.entryTime)} @ {t.entryPrice.toFixed(2)}</div>
          <div>平仓 {fmtTime(t.exitTime ?? 0)} @ {t.exitPrice?.toFixed(2) ?? "-"}</div>
          <div>
            SL {t.stopLoss?.toFixed(2) ?? "未设置"} / TP {t.takeProfit?.toFixed(2) ?? "未设置"} · 保证金{" "}
            {t.margin.toFixed(2)}
          </div>
          <div>MAE {t.mae.toFixed(2)} / MFE {t.mfe.toFixed(2)}</div>
          {t.entryDeductions && t.entryDeductions.length > 0 && (
            <div className="text-amber-700">
              进场质量扣分：
              {t.entryDeductions.map((d) => ` ${d.label}(${d.points})`).join("、")}
            </div>
          )}
          {t.disciplineFlags && t.disciplineFlags.length > 0 && (
            <div className="text-amber-700">
              纪律扣分：
              {t.disciplineFlags.map((d) => ` ${d.label}(${d.points})`).join("、")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ReplayScoreCard({ score, trades }: { score: ReplayScore; trades: ReplayTrade[] }) {
  const savedId = useReplayStore((s) => s.savedId);
  const isSaving = useReplayStore((s) => s.isSaving);
  const saveError = useReplayStore((s) => s.saveError);
  const saveSession = useReplayStore((s) => s.saveSession);

  return (
    <div data-testid="replay-score-card" className="space-y-2">
      <div className="flex items-center justify-between px-2 py-1.5 bg-gray-50 rounded">
        <span className="text-xs text-gray-600">总分</span>
        <span className="flex items-baseline gap-2">
          <span data-testid="replay-score-total" className="text-xl font-bold text-gray-900">
            {score.total}
          </span>
          <span data-testid="replay-score-grade" className={`text-sm font-bold ${GRADE_COLOR[score.grade] ?? "text-gray-600"}`}>
            {score.grade}
          </span>
        </span>
      </div>

      {score.sections.map((sec) => (
        <div key={sec.key} className="border border-gray-200 rounded">
          <div className="flex items-center justify-between px-2 py-1 bg-gray-50 border-b border-gray-200">
            <span className="text-[11px] font-semibold text-gray-700">
              {sec.title} <span className="text-gray-400 font-normal">×{sec.weight}</span>
            </span>
            <span
              data-testid={`replay-score-${sec.key}`}
              className="text-xs font-bold text-gray-800"
            >
              {sec.score}
            </span>
          </div>
          <div className="px-2 py-1 space-y-0.5">
            {sec.items.length === 0 ? (
              <div className="text-[10px] text-gray-400">无扣分项</div>
            ) : (
              sec.items.map((item, i) => (
                <div key={i} className="text-[10px] leading-tight">
                  <span className={item.points >= 0 ? "text-green-600" : "text-red-600"}>
                    {item.points >= 0 ? "+" : ""}
                    {item.points}
                  </span>{" "}
                  <span className="text-gray-700">{item.label}</span>
                  <span className="text-gray-400"> · {item.detail}</span>
                </div>
              ))
            )}
          </div>
        </div>
      ))}

      {trades.length > 0 && (
        <div className="border border-gray-200 rounded">
          <div className="px-2 py-1 bg-gray-50 border-b border-gray-200 text-[11px] font-semibold text-gray-700">
            逐笔明细（{trades.length} 笔）
          </div>
          <div>
            {trades.map((t) => (
              <TradeRow key={t.seq} t={t} />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px]">
        {savedId != null ? (
          <span className="text-green-600">已保存（#{savedId}）</span>
        ) : (
          <button
            data-testid="replay-save"
            className="px-2 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
            disabled={isSaving}
            onClick={() => void saveSession()}
          >
            {isSaving ? "保存中..." : "重新保存"}
          </button>
        )}
        {saveError && <span className="text-red-500">保存失败：{saveError}</span>}
      </div>
    </div>
  );
}
