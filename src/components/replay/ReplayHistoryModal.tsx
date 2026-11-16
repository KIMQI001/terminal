"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { useReplayStore } from "@/stores/replayStore";

/**
 * 历史回放存档 + 累计战绩
 */
export function ReplayHistoryModal({ onClose }: { onClose: () => void }) {
  const history = useReplayStore((s) => s.history);
  const stats = useReplayStore((s) => s.stats);
  const loading = useReplayStore((s) => s.historyLoading);
  const fetchHistory = useReplayStore((s) => s.fetchHistory);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      data-testid="replay-history-modal"
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] overflow-y-auto bg-white rounded-lg shadow-xl text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
          <span className="font-semibold text-gray-800">回放历史 · 累计战绩</span>
          <button className="p-1 rounded hover:bg-gray-200 text-gray-500" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* 累计统计 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="总场次" value={stats ? String(stats.overall.sessions) : "-"} testid="replay-stat-sessions" />
            <Stat label="平均分" value={stats ? stats.overall.avgScore.toFixed(1) : "-"} testid="replay-stat-avgscore" />
            <Stat
              label="累计盈亏"
              value={stats ? `${stats.overall.totalPnl >= 0 ? "+" : ""}${stats.overall.totalPnl.toFixed(2)}` : "-"}
              tone={stats && stats.overall.totalPnl >= 0 ? "up" : stats ? "down" : "flat"}
              testid="replay-stat-totalpnl"
            />
            <Stat
              label="总胜率"
              value={stats ? `${stats.overall.overallWinRate.toFixed(1)}%` : "-"}
              testid="replay-stat-winrate"
            />
          </div>

          {stats && stats.bySymbol.length > 0 && (
            <div className="border border-gray-200 rounded">
              <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 font-semibold text-gray-700 text-[11px]">
                按交易对
              </div>
              <table className="w-full text-[11px]">
                <thead className="text-gray-400">
                  <tr>
                    <th className="text-left px-3 py-1">交易对</th>
                    <th className="text-right px-3 py-1">场次</th>
                    <th className="text-right px-3 py-1">累计盈亏</th>
                    <th className="text-right px-3 py-1">平均分</th>
                    <th className="text-right px-3 py-1">胜率</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.bySymbol.map((s) => (
                    <tr key={s.symbol} className="border-t border-gray-100">
                      <td className="px-3 py-1 font-semibold">{s.symbol}</td>
                      <td className="px-3 py-1 text-right font-mono">{s.sessions}</td>
                      <td
                        className={`px-3 py-1 text-right font-mono ${
                          s.totalPnl >= 0 ? "text-green-600" : "text-red-600"
                        }`}
                      >
                        {s.totalPnl >= 0 ? "+" : ""}
                        {s.totalPnl.toFixed(2)}
                      </td>
                      <td className="px-3 py-1 text-right font-mono">{s.avgScore.toFixed(1)}</td>
                      <td className="px-3 py-1 text-right font-mono">{s.winRate.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 场次列表 */}
          <div className="border border-gray-200 rounded">
            <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 font-semibold text-gray-700 text-[11px]">
              回放场次（{history.length}）
            </div>
            {loading ? (
              <div className="py-4 text-center text-gray-400">加载中...</div>
            ) : history.length === 0 ? (
              <div className="py-4 text-center text-gray-400">还没有回放记录</div>
            ) : (
              <table className="w-full text-[11px]">
                <thead className="text-gray-400">
                  <tr>
                    <th className="text-left px-3 py-1">时间</th>
                    <th className="text-left px-3 py-1">交易对</th>
                    <th className="text-left px-3 py-1">周期</th>
                    <th className="text-right px-3 py-1">笔数</th>
                    <th className="text-right px-3 py-1">胜率</th>
                    <th className="text-right px-3 py-1">盈亏</th>
                    <th className="text-right px-3 py-1">分数</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-1 font-mono text-gray-500">{r.created_at}</td>
                      <td className="px-3 py-1 font-semibold">{r.symbol}</td>
                      <td className="px-3 py-1 text-gray-500">{r.timeframe}</td>
                      <td className="px-3 py-1 text-right font-mono">{r.total_trades}</td>
                      <td className="px-3 py-1 text-right font-mono">{r.win_rate.toFixed(1)}%</td>
                      <td
                        className={`px-3 py-1 text-right font-mono ${
                          r.net_pnl >= 0 ? "text-green-600" : "text-red-600"
                        }`}
                      >
                        {r.net_pnl >= 0 ? "+" : ""}
                        {r.net_pnl.toFixed(2)}
                      </td>
                      <td className="px-3 py-1 text-right font-mono">
                        {r.score_total.toFixed(0)}
                        <span className="text-gray-400 ml-1">{r.grade ?? ""}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "flat",
  testid,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "flat";
  testid?: string;
}) {
  const color = tone === "up" ? "text-green-600" : tone === "down" ? "text-red-600" : "text-gray-800";
  return (
    <div className="border border-gray-200 rounded px-3 py-2">
      <div className="text-[10px] text-gray-400">{label}</div>
      <div className={`text-base font-bold font-mono ${color}`} data-testid={testid}>
        {value}
      </div>
    </div>
  );
}
