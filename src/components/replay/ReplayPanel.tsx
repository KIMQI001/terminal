"use client";

import { useState } from "react";
import { History, X } from "lucide-react";
import { useReplayStore } from "@/stores/replayStore";
import { ReplayOrderForm } from "./ReplayOrderForm";
import { ReplayScoreCard } from "./ReplayScoreCard";
import { ReplayHistoryModal } from "./ReplayHistoryModal";
import { ReplayFillsList, ReplayOrdersList, ReplayPositionsList } from "./ReplayBook";

/**
 * 回放面板（图表右上角）
 * - idle：参数设置
 * - 进行中：模拟下单表单 + 持仓 / 挂单 / 成交
 * - finished：成绩单
 */
export function ReplayPanel() {
  const status = useReplayStore((s) => s.status);
  const isReplaying = useReplayStore((s) => s.isReplaying);
  const config = useReplayStore((s) => s.config);
  const setConfig = useReplayStore((s) => s.setConfig);
  const startReplay = useReplayStore((s) => s.startReplay);
  const stopReplay = useReplayStore((s) => s.stopReplay);
  const startError = useReplayStore((s) => s.startError);
  const view = useReplayStore((s) => s.view);
  const result = useReplayStore((s) => s.result);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<"positions" | "orders" | "fills">("positions");

  if (!isReplaying && status !== "finished") {
    // 开局失败(例如 K 线不足)—— 只显示错误条
    if (!startError) return null;
    return (
      <div
        data-testid="replay-start-error"
        className="w-[280px] px-2 py-1.5 rounded-lg border border-red-200 bg-red-50 text-[11px] text-red-600"
      >
        {startError}
      </div>
    );
  }

  const numField = (
    label: string,
    key: keyof typeof config,
    step = 1,
    min = 0,
    suffix?: string
  ) => (
    <div className="space-y-0.5">
      <label className="text-[10px] text-gray-500">{label}</label>
      <div className="flex items-center gap-1">
        <input
          data-testid={`replay-config-${key}`}
          type="number"
          step={step}
          min={min}
          value={String(config[key])}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) setConfig({ [key]: v } as Partial<typeof config>);
          }}
          className="w-full px-1.5 py-1 text-xs bg-[var(--bg-tertiary)] rounded border border-gray-200 text-gray-800 font-mono"
        />
        {suffix && <span className="text-[10px] text-gray-400">{suffix}</span>}
      </div>
    </div>
  );

  return (
    <div
      data-testid="replay-panel"
      className="w-[280px] max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white/95 backdrop-blur shadow-lg text-xs"
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-2 py-1.5 bg-orange-50 border-b border-orange-100 sticky top-0 z-10">
        <span className="font-semibold text-orange-700 text-[11px]">
          回放模式{isReplaying ? ` · ${config.symbol} ${config.timeframe}` : ""}
        </span>
        <div className="flex items-center gap-1">
          <button
            data-testid="replay-open-history"
            className="p-0.5 rounded hover:bg-orange-100 text-orange-600"
            title="历史战绩"
            onClick={() => setHistoryOpen(true)}
          >
            <History className="w-3.5 h-3.5" />
          </button>
          {isReplaying ? (
            <button
              data-testid="replay-exit"
              className="p-0.5 rounded hover:bg-orange-100 text-orange-600"
              title="退出回放"
              onClick={stopReplay}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              data-testid="replay-close-panel"
              className="p-0.5 rounded hover:bg-gray-100 text-gray-500"
              title="关闭"
              onClick={stopReplay}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="p-2 space-y-2">
        {status === "finished" && result ? (
          <>
            <button
              className="w-full py-1 rounded bg-orange-500 text-white hover:bg-orange-600 text-[11px]"
              onClick={() => startReplay()}
            >
              再来一场
            </button>
            <ReplayScoreCard score={result} trades={view.trades} />
          </>
        ) : (
          <>
            {/* 账户概览 */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px] text-gray-600">
              <span>权益</span>
              <span className="text-right font-semibold text-gray-900">{view.account.equity.toFixed(2)}</span>
              <span>可用</span>
              <span className="text-right">{view.account.cashFree.toFixed(2)}</span>
              <span>已实现</span>
              <span className={`text-right ${view.account.realizedPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                {view.account.realizedPnl >= 0 ? "+" : ""}
                {view.account.realizedPnl.toFixed(2)}
              </span>
              <span>浮动</span>
              <span className={`text-right ${view.account.unrealizedPnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                {view.account.unrealizedPnl >= 0 ? "+" : ""}
                {view.account.unrealizedPnl.toFixed(2)}
              </span>
              <span>保证金占用</span>
              <span className="text-right">{view.account.marginUsagePct.toFixed(1)}%</span>
              <span>最大回撤</span>
              <span className="text-right text-orange-600">{view.account.maxDrawdownPct.toFixed(2)}%</span>
            </div>

            <div className="h-px bg-gray-100" />

            <ReplayOrderForm />

            <div className="h-px bg-gray-100" />

            {/* 持仓 / 挂单 / 成交 */}
            <div className="flex gap-1">
              {(
                [
                  ["positions", `持仓 ${view.positions.length}`],
                  ["orders", `挂单 ${view.orders.filter((o) => o.status === "pending").length}`],
                  ["fills", `成交 ${view.fills.length}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  data-testid={`replay-tab-${key}`}
                  className={`flex-1 py-1 rounded text-[10px] ${
                    tab === key ? "bg-orange-100 text-orange-700 font-semibold" : "bg-gray-50 text-gray-500 hover:bg-gray-100"
                  }`}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "positions" && (
              <div data-testid="replay-positions">
                <ReplayPositionsList />
              </div>
            )}

            {tab === "orders" && (
              <div data-testid="replay-orders">
                <ReplayOrdersList />
              </div>
            )}

            {tab === "fills" && (
              <div data-testid="replay-fills">
                <ReplayFillsList />
              </div>
            )}

            {/* 参数（重开生效） */}
            <button
              data-testid="replay-toggle-settings"
              className="w-full py-1 rounded bg-gray-50 text-gray-500 hover:bg-gray-100 text-[10px]"
              onClick={() => setSettingsOpen((v) => !v)}
            >
              {settingsOpen ? "收起参数" : "参数设置（重开生效）"}
            </button>

            {settingsOpen && (
              <div className="space-y-1.5 border border-gray-200 rounded p-1.5" data-testid="replay-settings">
                <div className="grid grid-cols-2 gap-1.5">
                  {numField("回放根数", "barCount", 10, 10, "根")}
                  {numField("虚拟本金", "initialCapital", 100, 1, "U")}
                  {numField("固定手数", "quantity", 0.001, 0.001, "BTC")}
                  {numField("杠杆", "leverage", 1, 1, "x")}
                  {numField("最大持仓", "maxPositions", 1, 1, "笔")}
                  {numField("单笔风险上限", "maxRiskPerTradePct", 0.5, 0.1, "%")}
                </div>
                <button
                  data-testid="replay-apply-settings"
                  className="w-full py-1 rounded bg-orange-500 text-white hover:bg-orange-600 text-[11px]"
                  onClick={() => startReplay()}
                >
                  用新参数重开
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {historyOpen && <ReplayHistoryModal onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}
