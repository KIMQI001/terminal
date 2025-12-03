"use client";

import { useEffect, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { PerformanceCards } from "@/components/analysis/PerformanceCards";
import { SignalTable } from "@/components/analysis/SignalTable";
import { EquityCurve } from "@/components/analysis/EquityCurve";
import { DistributionCharts } from "@/components/analysis/DistributionCharts";
import { AIAnalyzer } from "@/components/analysis/AIAnalyzer";
import {
  fetchPerformanceStats,
  fetchSignals,
  fetchEquityCurve,
  checkHealth,
  PerformanceStats,
  Signal,
  EquityPoint,
} from "@/lib/analysis/api";

export default function AnalysisPage() {
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [days, setDays] = useState(30);

  // Check API health
  useEffect(() => {
    checkHealth().then(setIsConnected);
  }, []);

  // Fetch performance stats
  const {
    data: stats,
    isLoading: statsLoading,
    refetch: refetchStats,
  } = useQuery<PerformanceStats>({
    queryKey: ["analysis-stats", days],
    queryFn: () => fetchPerformanceStats(days),
    refetchInterval: 30000, // 30 seconds
    enabled: isConnected === true,
  });

  // Fetch signals
  const {
    data: signals,
    isLoading: signalsLoading,
    refetch: refetchSignals,
  } = useQuery<Signal[]>({
    queryKey: ["analysis-signals", days],
    queryFn: () => fetchSignals("all", days),
    refetchInterval: 30000,
    enabled: isConnected === true,
  });

  // Fetch equity curve
  const {
    data: equityCurve,
    isLoading: curveLoading,
    refetch: refetchCurve,
  } = useQuery<EquityPoint[]>({
    queryKey: ["equity-curve", days],
    queryFn: () => fetchEquityCurve(days),
    refetchInterval: 60000, // 1 minute
    enabled: isConnected === true,
  });

  const handleRefresh = useCallback(() => {
    refetchStats();
    refetchSignals();
    refetchCurve();
  }, [refetchStats, refetchSignals, refetchCurve]);

  // Connection error state
  if (isConnected === false) {
    return (
      <AuthGuard>
        <div className="min-h-screen bg-[var(--bg-primary)]">
          <header className="border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
            <Link
              href="/"
              className="text-blue-400 hover:text-blue-300 text-sm flex items-center gap-2"
            >
              ← 返回交易
            </Link>
            <h1 className="text-lg font-medium text-[var(--text-primary)]">
              AI 分析统计
            </h1>
            <div className="w-20" />
          </header>
          <main className="p-4">
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-6 text-center">
              <div className="text-2xl mb-2">🔌</div>
              <div className="text-red-400 font-medium mb-2">
                无法连接到分析服务
              </div>
              <div className="text-sm text-[var(--text-tertiary)] mb-4">
                请确保 analysis-service 正在运行 (端口 3002)
              </div>
              <button
                onClick={() => checkHealth().then(setIsConnected)}
                className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded text-sm transition-colors"
              >
                重试连接
              </button>
            </div>
          </main>
        </div>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[var(--bg-primary)]">
        {/* Header */}
        <header className="border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
          <Link
            href="/"
            className="text-blue-400 hover:text-blue-300 text-sm flex items-center gap-2"
          >
            ← 返回交易
          </Link>
          <h1 className="text-lg font-medium text-[var(--text-primary)]">
            AI 分析统计
          </h1>
          <div className="flex items-center gap-3">
            {/* Time range selector */}
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-2 py-1 text-sm text-[var(--text-primary)]"
            >
              <option value={7}>近 7 天</option>
              <option value={30}>近 30 天</option>
              <option value={90}>近 90 天</option>
              <option value={0}>全部</option>
            </select>
            {/* Refresh button */}
            <button
              onClick={handleRefresh}
              className="px-3 py-1 bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] transition-colors"
            >
              刷新
            </button>
          </div>
        </header>

        {/* Main content */}
        <main className="p-4 space-y-4 max-w-7xl mx-auto">
          {/* Loading state */}
          {isConnected === null && (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-3"></div>
              <span className="text-[var(--text-tertiary)]">连接分析服务...</span>
            </div>
          )}

          {isConnected === true && (
            <>
              {/* AI Analyzer */}
              <AIAnalyzer />

              {/* Performance Cards */}
              <PerformanceCards stats={stats || null} isLoading={statsLoading} />

              {/* Charts row */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <EquityCurve data={equityCurve || []} isLoading={curveLoading} />
                <DistributionCharts stats={stats || null} isLoading={statsLoading} />
              </div>

              {/* Signal Table */}
              <SignalTable signals={signals || []} isLoading={signalsLoading} />

              {/* Footer info */}
              <div className="text-center text-xs text-[var(--text-tertiary)] py-2">
                数据每 30 秒自动刷新 | 最后更新: {new Date().toLocaleTimeString("zh-CN")}
              </div>
            </>
          )}
        </main>
      </div>
    </AuthGuard>
  );
}
