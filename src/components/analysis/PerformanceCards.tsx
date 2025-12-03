"use client";

import { PerformanceStats } from "@/lib/analysis/api";

interface PerformanceCardsProps {
  stats: PerformanceStats | null;
  isLoading: boolean;
}

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  positive?: boolean;
  neutral?: boolean;
}

function StatCard({ title, value, subtitle, positive, neutral }: StatCardProps) {
  const valueColor = neutral
    ? "text-[var(--text-primary)]"
    : positive
    ? "text-green-500"
    : "text-red-500";

  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg p-4 border border-[var(--border)]">
      <div className="text-xs text-[var(--text-tertiary)] mb-1">{title}</div>
      <div className={`text-2xl font-bold ${valueColor}`}>{value}</div>
      {subtitle && (
        <div className="text-xs text-[var(--text-tertiary)] mt-1">
          {subtitle}
        </div>
      )}
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg p-4 border border-[var(--border)] animate-pulse">
      <div className="h-3 bg-[var(--bg-tertiary)] rounded w-16 mb-2"></div>
      <div className="h-7 bg-[var(--bg-tertiary)] rounded w-20"></div>
    </div>
  );
}

export function PerformanceCards({ stats, isLoading }: PerformanceCardsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <LoadingCard />
        <LoadingCard />
        <LoadingCard />
        <LoadingCard />
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="bg-[var(--bg-secondary)] rounded-lg p-4 border border-[var(--border)] text-center text-[var(--text-tertiary)]">
        无法加载统计数据
      </div>
    );
  }

  const winRatePercent = (stats.winRate * 100).toFixed(1);
  const expectancyFormatted = `${stats.expectancy >= 0 ? "+" : ""}${stats.expectancy.toFixed(2)}R`;
  const pnlFormatted = `${stats.totalPnlPercent >= 0 ? "+" : ""}${stats.totalPnlPercent.toFixed(2)}%`;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard
        title="总信号"
        value={stats.totalSignals.toString()}
        subtitle={`完成: ${stats.completedSignals}`}
        neutral
      />
      <StatCard
        title="胜率"
        value={`${winRatePercent}%`}
        subtitle={`${stats.winCount}胜 ${stats.lossCount}负`}
        positive={stats.winRate >= 0.5}
      />
      <StatCard
        title="盈亏比"
        value={stats.avgRR.toFixed(2)}
        subtitle={`期望: ${expectancyFormatted}`}
        positive={stats.avgRR >= 1}
      />
      <StatCard
        title="累计盈亏"
        value={pnlFormatted}
        subtitle={`盈利因子: ${
          stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)
        }`}
        positive={stats.totalPnlPercent >= 0}
      />
    </div>
  );
}
