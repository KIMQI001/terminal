"use client";

import { useEffect, useState } from "react";
import { Pause, Play, StepBack, StepForward, RotateCcw, Square } from "lucide-react";
import { useReplayStore } from "@/stores/replayStore";

/**
 * 回放控制条（图表底部）
 * - ⏮ 重开本次回放 / ▶⏸ 播放暂停 / 单步前进 / 单步后退 / 跳到最新
 * - 速度、进度、虚拟账户、「结束回放」
 */
export function ReplayControlBar() {
  const status = useReplayStore((s) => s.status);
  const isReplaying = useReplayStore((s) => s.isReplaying);
  const cursor = useReplayStore((s) => s.cursor);
  const frontier = useReplayStore((s) => s.frontier);
  const bars = useReplayStore((s) => s.bars);
  const view = useReplayStore((s) => s.view);
  const config = useReplayStore((s) => s.config);
  const togglePlay = useReplayStore((s) => s.togglePlay);
  const stepForward = useReplayStore((s) => s.stepForward);
  const stepBack = useReplayStore((s) => s.stepBack);
  const jumpToFront = useReplayStore((s) => s.jumpToFront);
  const setSpeed = useReplayStore((s) => s.setSpeed);
  const endReplay = useReplayStore((s) => s.endReplay);

  const [speedOpen, setSpeedOpen] = useState(false);

  useEffect(() => {
    if (status === "running") setSpeedOpen(false);
  }, [status]);

  if (!isReplaying && status !== "finished") return null;

  const total = bars.length;
  const shown = cursor + 1;
  const isReview = status === "review";
  const atEnd = frontier + 1 >= total;
  const equity = view.account.equity;
  const pnl = equity - view.account.initialCapital;
  const pnlPct = view.account.initialCapital > 0 ? (pnl / view.account.initialCapital) * 100 : 0;

  const btn =
    "w-7 h-7 flex items-center justify-center rounded text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-30 disabled:cursor-not-allowed transition-colors";

  return (
    <div
      data-testid="replay-control-bar"
      className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 h-9 rounded-lg border border-gray-200 bg-white/95 backdrop-blur shadow-lg text-xs"
    >
      <span className="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-semibold">回放</span>

      <button className={btn} title="重开本次回放" onClick={() => useReplayStore.getState().startReplay()}>
        <RotateCcw className="w-3.5 h-3.5" />
      </button>

      <button
        data-testid="replay-play"
        className={btn}
        title={status === "running" ? "暂停" : "播放"}
        disabled={atEnd}
        onClick={togglePlay}
      >
        {status === "running" ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      </button>

      <button
        data-testid="replay-step-back"
        className={btn}
        title="单步后退（仅回看视图，不改账本）"
        disabled={cursor < 0}
        onClick={stepBack}
      >
        <StepBack className="w-3.5 h-3.5" />
      </button>

      <button
        data-testid="replay-step-forward"
        className={btn}
        title="单步前进"
        disabled={atEnd}
        onClick={stepForward}
      >
        <StepForward className="w-3.5 h-3.5" />
      </button>

      {/* 跳到最新:回看态 = 游标跳到最新一根;跟随态 = 把图表视角拉回最新 K */}
      {isReplaying && (
        <button
          data-testid="replay-jump-to-front"
          className="px-2 h-7 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium"
          title={isReview ? "跳到最新一根" : "把图表视角拉回最新 K"}
          onClick={jumpToFront}
        >
          {isReview ? `跳到最新（第 ${frontier + 1} 根）` : "回到最新"}
        </button>
      )}

      {/* 速度 */}
      <div className="relative">
        <button
          data-testid="replay-speed"
          className="px-2 h-7 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 font-mono"
          onClick={() => setSpeedOpen((v) => !v)}
        >
          {config.speed}x
        </button>
        {speedOpen && (
          <div className="absolute bottom-8 left-0 bg-white border border-gray-200 rounded shadow-lg overflow-hidden">
            {[0.5, 1, 2, 4, 8].map((s) => (
              <button
                key={s}
                className={`block w-16 px-2 py-1 text-left hover:bg-gray-100 ${
                  config.speed === s ? "font-semibold text-blue-600" : "text-gray-600"
                }`}
                onClick={() => {
                  setSpeed(s);
                  setSpeedOpen(false);
                }}
              >
                {s}x
              </button>
            ))}
          </div>
        )}
      </div>

      <span data-testid="replay-progress" className="font-mono text-gray-500">
        {shown}/{total}
      </span>

      <span className="w-px h-4 bg-gray-200" />

      <span data-testid="replay-balance" className="font-mono text-gray-600">
        权益 <span className="font-semibold">{equity.toFixed(2)}</span>
      </span>
      <span className={`font-mono ${pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
        {pnl >= 0 ? "+" : ""}
        {pnl.toFixed(2)} ({pnlPct.toFixed(2)}%)
      </span>

      {status !== "finished" && (
        <button
          data-testid="replay-end"
          className="flex items-center gap-1 px-2 h-7 rounded bg-orange-500 text-white hover:bg-orange-600 font-medium"
          onClick={endReplay}
        >
          <Square className="w-3 h-3" />
          结束回放
        </button>
      )}
    </div>
  );
}
