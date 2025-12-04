"use client";

import { useState } from "react";
import { Signal } from "@/lib/analysis/api";
import { SignalDetailModal } from "./SignalDetailModal";

interface SignalTableProps {
  signals: Signal[];
  isLoading: boolean;
}

type StatusFilter = "all" | "pending" | "entered" | "completed";

function getStatusIcon(status: Signal["status"]): string {
  switch (status) {
    case "profit":
      return "✅";
    case "stopped":
      return "❌";
    case "entered":
      return "📊";
    case "pending":
      return "⏳";
    case "expired":
      return "⏰";
    default:
      return "❓";
  }
}

function getStatusLabel(status: Signal["status"]): string {
  switch (status) {
    case "profit":
      return "止盈";
    case "stopped":
      return "止损";
    case "entered":
      return "持仓中";
    case "pending":
      return "待入场";
    case "expired":
      return "已过期";
    default:
      return status;
  }
}

function getDirectionClass(direction: Signal["direction"]): string {
  return direction === "long" ? "text-green-500" : "text-red-500";
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPrice(price: number | null | undefined): string {
  if (price == null) return "-";
  if (price >= 1000) return price.toFixed(0);
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

export function SignalTable({ signals, isLoading }: SignalTableProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null);

  const filteredSignals = signals.filter((signal) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "completed") {
      return signal.status === "profit" || signal.status === "stopped";
    }
    return signal.status === statusFilter;
  });

  if (isLoading) {
    return (
      <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] p-8">
        <div className="flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-3"></div>
          <span className="text-[var(--text-tertiary)]">加载信号数据...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
      {/* Header with filters */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">
          信号列表
        </h3>
        <div className="flex gap-1">
          {(["all", "pending", "entered", "completed"] as StatusFilter[]).map(
            (filter) => (
              <button
                key={filter}
                onClick={() => setStatusFilter(filter)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  statusFilter === filter
                    ? "bg-blue-500/20 text-blue-400"
                    : "text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                }`}
              >
                {filter === "all"
                  ? "全部"
                  : filter === "pending"
                  ? "待入场"
                  : filter === "entered"
                  ? "持仓中"
                  : "已完成"}
              </button>
            )
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[var(--text-tertiary)] border-b border-[var(--border)]">
              <th className="px-4 py-2 text-left font-medium">状态</th>
              <th className="px-4 py-2 text-left font-medium">时间</th>
              <th className="px-4 py-2 text-left font-medium">交易对</th>
              <th className="px-4 py-2 text-left font-medium">周期</th>
              <th className="px-4 py-2 text-left font-medium">方向</th>
              <th className="px-4 py-2 text-right font-medium">入场价</th>
              <th className="px-4 py-2 text-right font-medium">止损</th>
              <th className="px-4 py-2 text-right font-medium">盈亏</th>
              <th className="px-4 py-2 text-center font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredSignals.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-8 text-center text-[var(--text-tertiary)]"
                >
                  暂无信号数据
                </td>
              </tr>
            ) : (
              filteredSignals.map((signal) => (
                <tr
                  key={signal.id}
                  className="border-b border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <td className="px-4 py-2">
                    <span title={getStatusLabel(signal.status)}>
                      {getStatusIcon(signal.status)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-[var(--text-secondary)]">
                    {formatDate(signal.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-[var(--text-primary)] font-medium">
                    {signal.symbol}
                  </td>
                  <td className="px-4 py-2 text-[var(--text-secondary)]">
                    {signal.timeframe}
                  </td>
                  <td className="px-4 py-2">
                    <span className={getDirectionClass(signal.direction)}>
                      {signal.direction === "long" ? "多" : "空"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right text-[var(--text-primary)]">
                    {formatPrice(signal.entryPrice)}
                  </td>
                  <td className="px-4 py-2 text-right text-red-400">
                    {formatPrice(signal.stopLoss)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {signal.pnlPercent !== null ? (
                      <span
                        className={
                          signal.pnlPercent >= 0
                            ? "text-green-500"
                            : "text-red-500"
                        }
                      >
                        {signal.pnlPercent >= 0 ? "+" : ""}
                        {signal.pnlPercent.toFixed(2)}%
                      </span>
                    ) : (
                      <span className="text-[var(--text-tertiary)]">-</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <button
                      onClick={() => setSelectedSignal(signal)}
                      className="text-blue-400 hover:text-blue-300 text-xs"
                    >
                      详情
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Signal Detail Modal */}
      {selectedSignal && (
        <SignalDetailModal
          signal={selectedSignal}
          onClose={() => setSelectedSignal(null)}
        />
      )}
    </div>
  );
}
