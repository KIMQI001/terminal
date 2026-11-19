"use client";

import { useState } from "react";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useOrderStore } from "@/stores/orderStore";
import type { IctSetupSignal, IctSetupState } from "@/lib/chart/indicators/ictSetup";

/** 状态徽章：watching 灰 / touched 黄 / swept 橙 / displaced 蓝 / ready 绿(★) / invalid 灰删除线 */
const STATE_META: Record<IctSetupState, { label: string; cls: string }> = {
  watching: { label: "观察", cls: "bg-gray-100 text-gray-500" },
  touched: { label: "触及", cls: "bg-yellow-100 text-yellow-700" },
  swept: { label: "已扫荡", cls: "bg-orange-100 text-orange-600" },
  displaced: { label: "已位移", cls: "bg-blue-100 text-blue-600" },
  ready: { label: "★可入场", cls: "bg-green-100 text-green-700" },
  invalid: { label: "失效", cls: "bg-gray-100 text-gray-400 line-through" },
};

/** 入场档位：0=激进 1=中间 2=保守（点击循环） */
const ENTRY_PRESETS = ["激进", "中间", "保守"];

function fmt(n: number | undefined, digits = 2): string {
  if (n === undefined || n === null || !isFinite(n)) return "-";
  return n.toFixed(digits);
}

export function ICTSetupPanel() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [entryPreset, setEntryPreset] = useState(1);
  const { enabled, ictSetups, ictSetupConfig, setIctSetupConfig } = useIndicatorStore();
  const { setPrefillData, setTradingLines, openModal } = useOrderStore();

  if (!enabled.ictSetup) return null;

  /** 三档入场价：激进=POI 近端，中间=中值，保守=POI 深端 */
  const entryFor = (s: IctSetupSignal): number | undefined => {
    if (!s.entry) return undefined;
    const { zoneLow, zoneHigh } = s.entry;
    const mid = (zoneLow + zoneHigh) / 2;
    if (s.direction === "bullish") {
      return entryPreset === 0 ? zoneHigh : entryPreset === 2 ? zoneLow : mid;
    }
    return entryPreset === 0 ? zoneLow : entryPreset === 2 ? zoneHigh : mid;
  };

  /** 一键预填开单（仅 ready 时可用；绝不自动下单） */
  const handlePrefill = (s: IctSetupSignal) => {
    if (s.state !== "ready" || !s.entry || s.stopLoss === undefined) return;
    const entry = entryFor(s);
    if (entry === undefined) return;
    const side = s.direction === "bullish" ? "buy" : "sell";
    const tp = s.targets?.[0]?.price;
    const risk = Math.abs(entry - s.stopLoss);
    const takeProfit =
      tp ??
      (side === "buy" ? entry + risk * 2 : entry - risk * 2);

    setTradingLines([
      { price: entry, type: "entry", side },
      { price: s.stopLoss, type: "stopLoss", side },
      { price: takeProfit, type: "takeProfit", side },
    ]);
    setPrefillData({ side, entry, stopLoss: s.stopLoss, takeProfit });
    openModal();
  };

  return (
    <div
      data-testid="ict-setup-panel"
      className="bg-white/95 border border-gray-200 rounded-lg shadow-lg w-[248px]"
    >
      {/* 标题栏 */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="text-xs font-semibold text-gray-600">ICT Setup</span>
        <span className="text-gray-400 text-[10px]">{isCollapsed ? "▶" : "▼"}</span>
      </div>

      {!isCollapsed && (
        <div className="px-2 py-2 space-y-2">
          {ictSetups.length === 0 ? (
            <div className="text-[9px] text-gray-400 py-2 text-center">
              数据不足（K 线 &lt; 30 或无有效摆动点）
            </div>
          ) : (
            ictSetups.map((s) => {
              const meta = STATE_META[s.state];
              const isBull = s.direction === "bullish";
              const accent = isBull ? "text-cyan-600" : "text-orange-500";
              const entry = entryFor(s);
              const tp1 = s.targets?.[0];
              const poolLabel = `${s.pool.isEqual ? "等" : "前"}${isBull ? "低" : "高"}池`;

              return (
                <div
                  key={s.id}
                  data-testid={`ict-setup-${s.direction}`}
                  data-state={s.state}
                  className={`rounded border px-1.5 py-1 text-[9px] leading-tight ${
                    s.state === "ready"
                      ? "border-green-300 bg-green-50"
                      : "border-gray-200 bg-gray-50/60"
                  }`}
                >
                  {/* 标题行 */}
                  <div className="flex items-center justify-between">
                    <span className={`font-bold ${accent}`}>{isBull ? "多" : "空"}</span>
                    <span className={`px-1 rounded font-semibold ${meta.cls}`}>{meta.label}</span>
                  </div>

                  {/* 池 / 扫荡 / 位移 */}
                  <div className="mt-0.5 text-gray-500">
                    池 {fmt(s.pool.level)}
                    {s.pool.isEqual ? ` ×${s.pool.strength}` : ""} ({poolLabel})
                    {s.sweep ? ` · 扫荡 ${fmt(s.sweep.extreme)}` : ""}
                    {s.displacement ? ` · 位移 ${fmt(s.displacement.level)}` : ""}
                  </div>
                  {/* 观察态：距离池位还有多远 */}
                  {s.state === "watching" && (
                    <div className="text-gray-400">
                      距池位 {fmt(Math.abs(s.currentPrice - s.pool.level))} 点
                    </div>
                  )}

                  {/* POI / 入场 / 止损 / 目标 */}
                  {s.poi && (
                    <div className="mt-0.5 text-gray-500">
                      POI({s.poi.type.toUpperCase()}) {fmt(s.poi.low)} – {fmt(s.poi.high)}
                    </div>
                  )}
                  {s.entry && (
                    <div
                      className="mt-0.5 flex items-center justify-between cursor-pointer hover:bg-gray-100 rounded px-0.5"
                      onClick={() => setEntryPreset((p) => (p + 1) % 3)}
                      title="点击切换入场档位：激进 / 中间 / 保守"
                    >
                      <span className="text-gray-500">
                        入场 {fmt(entry)}
                        <span className="ml-1 px-1 rounded bg-gray-200 text-gray-600">
                          {ENTRY_PRESETS[entryPreset]}
                        </span>
                      </span>
                    </div>
                  )}
                  {s.stopLoss !== undefined && (
                    <div className="text-red-600">止损 {fmt(s.stopLoss)}</div>
                  )}
                  {tp1 && (
                    <div className="text-green-700">
                      目标 {fmt(tp1.price)} ({tp1.label})
                      {s.rr !== undefined ? ` · R=${s.rr.toFixed(1)}` : ""}
                    </div>
                  )}

                  {/* 状态说明 */}
                  {s.reason && (
                    <div className="mt-0.5 text-gray-400 break-all">{s.reason}</div>
                  )}

                  {/* 一键预填开单 */}
                  <button
                    data-testid={`ict-setup-prefill-${s.direction}`}
                    disabled={s.state !== "ready"}
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePrefill(s);
                    }}
                    className={`mt-1 w-full py-0.5 rounded font-semibold border transition-colors ${
                      s.state === "ready"
                        ? "bg-green-600 text-white border-green-600 hover:bg-green-700"
                        : "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                    }`}
                  >
                    {s.state === "ready" ? "一键预填开单" : "等待可入场"}
                  </button>
                </div>
              );
            })
          )}

          {/* 参数区 */}
          <div className="border-t border-gray-100 pt-1">
            <button
              data-testid="ict-setup-params-toggle"
              onClick={() => setShowParams(!showParams)}
              className="text-[9px] text-gray-400 hover:text-gray-600"
            >
              {showParams ? "▼" : "▶"} 参数
            </button>
            {showParams && (
              <div className="mt-1 space-y-1 text-[9px] text-gray-500">
                <label className="flex items-center justify-between gap-1">
                  <span>池容差</span>
                  <input
                    type="number"
                    step={0.0001}
                    value={ictSetupConfig.poolTolerance}
                    onChange={(e) =>
                      setIctSetupConfig({ poolTolerance: Number(e.target.value) })
                    }
                    className="w-16 border border-gray-200 rounded px-1 py-0.5 font-mono text-[9px]"
                  />
                </label>
                <label className="flex items-center justify-between gap-1">
                  <span>收回 K 数</span>
                  <input
                    type="number"
                    min={1}
                    value={ictSetupConfig.sweepReclaimBars}
                    onChange={(e) =>
                      setIctSetupConfig({ sweepReclaimBars: Number(e.target.value) })
                    }
                    className="w-16 border border-gray-200 rounded px-1 py-0.5 font-mono text-[9px]"
                  />
                </label>
                <label className="flex items-center justify-between gap-1">
                  <span>位移 K 数</span>
                  <input
                    type="number"
                    min={1}
                    value={ictSetupConfig.displacementBars}
                    onChange={(e) =>
                      setIctSetupConfig({ displacementBars: Number(e.target.value) })
                    }
                    className="w-16 border border-gray-200 rounded px-1 py-0.5 font-mono text-[9px]"
                  />
                </label>
                <label className="flex items-center justify-between gap-1">
                  <span>失效 K 数</span>
                  <input
                    type="number"
                    min={1}
                    value={ictSetupConfig.setupExpiryBars}
                    onChange={(e) =>
                      setIctSetupConfig({ setupExpiryBars: Number(e.target.value) })
                    }
                    className="w-16 border border-gray-200 rounded px-1 py-0.5 font-mono text-[9px]"
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
