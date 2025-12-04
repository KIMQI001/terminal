"use client";

import { Signal } from "@/lib/analysis/api";

interface SignalDetailModalProps {
  signal: Signal;
  onClose: () => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatPrice(price: number | null | undefined): string {
  if (price == null) return "-";
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function getStatusColor(status: Signal["status"]): string {
  switch (status) {
    case "profit":
      return "text-green-500";
    case "stopped":
      return "text-red-500";
    case "entered":
      return "text-blue-400";
    case "pending":
      return "text-yellow-400";
    case "expired":
      return "text-gray-400";
    default:
      return "text-gray-400";
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

function getConfidenceLabel(confidence: Signal["confidence"]): string {
  switch (confidence) {
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
    default:
      return confidence;
  }
}

export function SignalDetailModal({ signal, onClose }: SignalDetailModalProps) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <span className="text-lg font-medium text-[var(--text-primary)]">
              {signal.symbol}
            </span>
            <span className="text-sm text-[var(--text-tertiary)]">
              {signal.timeframe}
            </span>
            <span
              className={`text-sm font-medium ${
                signal.direction === "long" ? "text-green-500" : "text-red-500"
              }`}
            >
              {signal.direction === "long" ? "做多" : "做空"}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Status & Time */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-[var(--text-tertiary)] mb-1">
                状态
              </div>
              <div className={`font-medium ${getStatusColor(signal.status)}`}>
                {getStatusLabel(signal.status)}
              </div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-tertiary)] mb-1">
                置信度
              </div>
              <div className="text-[var(--text-primary)]">
                {getConfidenceLabel(signal.confidence)}
              </div>
            </div>
          </div>

          {/* Prices */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-[var(--text-tertiary)] mb-1">
                入场价格
              </div>
              <div className="text-[var(--text-primary)] font-mono">
                {formatPrice(signal.entryPrice)}
              </div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-tertiary)] mb-1">
                止损价格
              </div>
              <div className="text-red-400 font-mono">
                {formatPrice(signal.stopLoss)}
              </div>
            </div>
          </div>

          {/* Take Profits */}
          <div>
            <div className="text-xs text-[var(--text-tertiary)] mb-1">
              止盈目标
            </div>
            <div className="flex gap-2 flex-wrap">
              {signal.takeProfits.map((tp, index) => (
                <span
                  key={index}
                  className="bg-green-500/20 text-green-400 px-2 py-1 rounded text-sm font-mono"
                >
                  TP{index + 1}: {formatPrice(tp)}
                </span>
              ))}
            </div>
          </div>

          {/* Risk/Reward */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-[var(--text-tertiary)] mb-1">
                计划盈亏比
              </div>
              <div className="text-[var(--text-primary)]">
                {(signal.riskReward ?? 0).toFixed(2)}
              </div>
            </div>
            {signal.actualRR != null && (
              <div>
                <div className="text-xs text-[var(--text-tertiary)] mb-1">
                  实际盈亏比
                </div>
                <div
                  className={
                    signal.actualRR >= 0 ? "text-green-500" : "text-red-500"
                  }
                >
                  {signal.actualRR >= 0 ? "+" : ""}
                  {(signal.actualRR ?? 0).toFixed(2)}
                </div>
              </div>
            )}
          </div>

          {/* PnL */}
          {signal.pnlPercent != null && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-[var(--text-tertiary)] mb-1">
                  盈亏百分比
                </div>
                <div
                  className={`font-medium ${
                    signal.pnlPercent >= 0 ? "text-green-500" : "text-red-500"
                  }`}
                >
                  {signal.pnlPercent >= 0 ? "+" : ""}
                  {(signal.pnlPercent ?? 0).toFixed(2)}%
                </div>
              </div>
              {signal.exitPrice !== null && (
                <div>
                  <div className="text-xs text-[var(--text-tertiary)] mb-1">
                    退出价格
                  </div>
                  <div className="text-[var(--text-primary)] font-mono">
                    {formatPrice(signal.exitPrice)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Timestamps */}
          <div className="grid grid-cols-1 gap-2 pt-2 border-t border-[var(--border)]">
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-tertiary)]">创建时间</span>
              <span className="text-[var(--text-secondary)]">
                {formatDate(signal.createdAt)}
              </span>
            </div>
            {signal.enteredAt && (
              <div className="flex justify-between text-sm">
                <span className="text-[var(--text-tertiary)]">入场时间</span>
                <span className="text-[var(--text-secondary)]">
                  {formatDate(signal.enteredAt)}
                </span>
              </div>
            )}
            {signal.exitedAt && (
              <div className="flex justify-between text-sm">
                <span className="text-[var(--text-tertiary)]">退出时间</span>
                <span className="text-[var(--text-secondary)]">
                  {formatDate(signal.exitedAt)}
                </span>
              </div>
            )}
          </div>

          {/* Reasoning */}
          {signal.reasoning && (
            <div className="pt-2 border-t border-[var(--border)]">
              <div className="text-xs text-[var(--text-tertiary)] mb-2">
                AI 分析理由
              </div>
              <div className="text-sm text-[var(--text-secondary)] bg-[var(--bg-tertiary)] rounded p-3 whitespace-pre-wrap">
                {signal.reasoning}
              </div>
            </div>
          )}

          {/* Exit Reason */}
          {signal.exitReason && (
            <div>
              <div className="text-xs text-[var(--text-tertiary)] mb-1">
                退出原因
              </div>
              <div className="text-sm text-[var(--text-secondary)]">
                {signal.exitReason}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[var(--border)] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-[var(--bg-tertiary)] hover:bg-[var(--border)] rounded text-sm text-[var(--text-primary)] transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
