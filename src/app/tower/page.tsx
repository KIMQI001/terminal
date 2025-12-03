"use client";

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { TowerList, TowerOrderModal } from "@/components/tower";
import { TowerBlock } from "@/components/tower/types";
import { fetchTowerBlocks, TowerBlocksResult } from "@/lib/analysis/api";
import { useChartStore } from "@/stores/chartStore";

export default function TowerPage() {
  const { symbol } = useChartStore();
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<TowerBlock | null>(null);

  // Fetch tower blocks from backend
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useQuery<TowerBlocksResult>({
    queryKey: ["tower-blocks", symbol],
    queryFn: () => fetchTowerBlocks(symbol),
    refetchInterval: 60000, // Auto refresh every 60 seconds
    staleTime: 30000, // Consider data stale after 30 seconds
  });

  const handleRefresh = useCallback(() => {
    refetch();
    setLastRefresh(new Date());
  }, [refetch]);

  const handleOrder = useCallback((block: TowerBlock) => {
    setSelectedBlock(block);
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedBlock(null);
  }, []);

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
            <span className="text-xs font-normal text-[var(--text-tertiary)]">
              {symbol}
            </span>
          </h1>

          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="p-2 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="刷新塔块数据"
          >
            <svg
              className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
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
                <span className="text-[var(--text-secondary)]">筛选:</span>{" "}
                FVG/OTE 填充度 &lt;22%，OB 不限
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

          {/* Error State */}
          {error && (
            <div className="p-4 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-red-400 text-sm">
                {error instanceof Error ? error.message : "加载失败"}
              </p>
              <button
                onClick={handleRefresh}
                className="mt-2 text-xs text-red-400 hover:text-red-300 underline"
              >
                点击重试
              </button>
            </div>
          )}

          {/* Loading State */}
          {isLoading && !data && (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-3" />
              <span className="text-[var(--text-tertiary)]">
                加载塔块数据中...
              </span>
            </div>
          )}

          {/* Tower List */}
          {data && (
            <TowerList
              currentPrice={data.currentPrice}
              blocks={data.blocks}
              onOrder={handleOrder}
            />
          )}

          {/* Empty State */}
          {data && data.blocks.length === 0 && (
            <div className="text-center py-12">
              <div className="text-4xl mb-4">🏯</div>
              <div className="text-[var(--text-tertiary)] mb-2">
                暂无符合条件的塔块
              </div>
              <p className="text-xs text-[var(--text-tertiary)]">
                FVG/OTE 需要填充度 &lt;22%
              </p>
            </div>
          )}
        </main>

        {/* Footer */}
        <footer className="border-t border-[var(--border)] px-4 py-2 text-center">
          <p className="text-xs text-[var(--text-tertiary)]">
            数据来源: 后端多周期 ICT 分析 (5m, 15m, 1h, 4h, 1d)
            {data?.timestamp && (
              <span className="ml-2">
                更新于 {new Date(data.timestamp).toLocaleTimeString("zh-CN")}
              </span>
            )}
          </p>
        </footer>

        {/* Order Modal */}
        {selectedBlock && (
          <TowerOrderModal block={selectedBlock} onClose={handleCloseModal} />
        )}
      </div>
    </AuthGuard>
  );
}
