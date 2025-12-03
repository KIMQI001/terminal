"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { TowerList } from "@/components/tower";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useChartStore } from "@/stores/chartStore";

export default function TowerPage() {
  const [isClient, setIsClient] = useState(false);

  // Get data from stores
  const { multiTimeframeFVG, multiTimeframeOB, multiTimeframeOTE } =
    useIndicatorStore();
  const { candles } = useChartStore();

  // Get current price from last candle
  const currentPrice =
    candles.length > 0 ? candles[candles.length - 1].close : 0;

  // Handle hydration
  useEffect(() => {
    setIsClient(true);
  }, []);

  const handleRefresh = () => {
    // Force re-render by triggering a state update
    setIsClient(false);
    setTimeout(() => setIsClient(true), 100);
  };

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[var(--bg-primary)]">
        {/* Header */}
        <header className="border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
          <Link
            href="/"
            className="text-blue-400 hover:text-blue-300 text-sm flex items-center gap-2"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            返回交易
          </Link>

          <h1 className="text-lg font-medium text-[var(--text-primary)] flex items-center gap-2">
            <span>🏯</span>
            守塔策略
          </h1>

          <button
            onClick={handleRefresh}
            className="p-2 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title="刷新塔块数据"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </header>

        {/* Main Content */}
        <main className="p-4 max-w-2xl mx-auto">
          {/* Rules Summary */}
          <div className="mb-4 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">
              塔块规则
            </h3>
            <ul className="text-xs text-[var(--text-tertiary)] space-y-1">
              <li>
                <span className="text-[var(--text-secondary)]">筛选:</span> FVG/OTE
                填充度 &lt;22%，OB 不限
              </li>
              <li>
                <span className="text-[var(--text-secondary)]">入场:</span>{" "}
                FVG/OB 用 0.22 位，OTE 用 0.675 位
              </li>
              <li>
                <span className="text-[var(--text-secondary)]">止损:</span>{" "}
                塔块边界，最大 200 点
              </li>
              <li>
                <span className="text-[var(--text-secondary)]">止盈:</span>{" "}
                对立塔块，最小 1000 点
              </li>
            </ul>
          </div>

          {/* Tower List */}
          {isClient ? (
            currentPrice > 0 ? (
              <TowerList
                currentPrice={currentPrice}
                multiTimeframeFVG={multiTimeframeFVG}
                multiTimeframeOB={multiTimeframeOB}
                multiTimeframeOTE={multiTimeframeOTE}
              />
            ) : (
              <div className="text-center py-12">
                <div className="text-[var(--text-tertiary)] mb-2">
                  暂无 K 线数据
                </div>
                <p className="text-xs text-[var(--text-tertiary)]">
                  请先返回交易页面加载 K 线数据
                </p>
              </div>
            )
          ) : (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </main>

        {/* Footer */}
        <footer className="border-t border-[var(--border)] px-4 py-2 text-center">
          <p className="text-xs text-[var(--text-tertiary)]">
            塔块数据来自多周期 ICT 指标分析 (5m, 15m, 1h, 4h, 1d)
          </p>
        </footer>
      </div>
    </AuthGuard>
  );
}
