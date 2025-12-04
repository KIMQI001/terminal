"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { TowerList, TowerOrderModal } from "@/components/tower";
import { TowerBlock } from "@/components/tower/types";
import { fetchTowerBlocks, TowerBlocksResult } from "@/lib/analysis/api";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore } from "@/stores/orderStore";
import { usePositionStore } from "@/stores/positionStore";

// localStorage keys
const STORAGE_KEYS = {
  BASE_MARGIN: "tower_base_margin",
  TOWER_LAYERS: "tower_layers",
};

export default function TowerPage() {
  const { symbol } = useChartStore();
  const { placeOrder } = useOrderStore();
  const { currentLeverage, fetchLeverage } = usePositionStore();
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<TowerBlock | null>(null);

  // 设置状态
  const [baseMargin, setBaseMargin] = useState(100);
  const [towerLayers, setTowerLayers] = useState(3);
  const [isAutoOrdering, setIsAutoOrdering] = useState(false);
  const [orderProgress, setOrderProgress] = useState<{
    current: number;
    total: number;
    errors: string[];
  } | null>(null);

  // 从 localStorage 加载设置
  useEffect(() => {
    const savedMargin = localStorage.getItem(STORAGE_KEYS.BASE_MARGIN);
    const savedLayers = localStorage.getItem(STORAGE_KEYS.TOWER_LAYERS);

    if (savedMargin) setBaseMargin(Number(savedMargin));
    if (savedLayers) setTowerLayers(Number(savedLayers));
  }, []);

  // 保存设置到 localStorage
  const handleMarginChange = (value: number) => {
    setBaseMargin(value);
    localStorage.setItem(STORAGE_KEYS.BASE_MARGIN, String(value));
  };

  const handleLayersChange = (value: number) => {
    setTowerLayers(value);
    localStorage.setItem(STORAGE_KEYS.TOWER_LAYERS, String(value));
  };

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

  // 获取当前杠杆
  useEffect(() => {
    fetchLeverage(symbol.replace("/", ""));
  }, [symbol, fetchLeverage]);

  // 计算下单数量（基于保证金）
  const calculateQuantity = useCallback(
    (margin: number, price: number) => {
      // 仓位价值 = 保证金 × 杠杆
      const positionValue = margin * currentLeverage;
      // 数量 = 仓位价值 / 价格，保留3位小数
      return Math.floor((positionValue / price) * 1000) / 1000;
    },
    [currentLeverage]
  );

  // 止损止盈参数（与 TowerList 一致）
  const MAX_SL_DISTANCE = 200;
  const MIN_TP_DISTANCE = 1000;
  const MIN_DISTANCE_RATIO = 0.003; // 最小距离：千分之三

  // 一键守塔
  const handleAutoTower = useCallback(async () => {
    if (!data?.blocks || !data.currentPrice) return;

    const currentPrice = data.currentPrice;
    const rawBlocks = data.blocks;

    // 转换为带止损止盈的塔块（与 TowerList 逻辑一致）
    const allRawBlocks = rawBlocks.map((b) => ({
      ...b,
      stopLoss: 0,
      takeProfit: 0,
    }));

    // 分离多空
    const allBearish = allRawBlocks
      .filter((b) => b.type === "bearish")
      .sort((a, b) => b.entry - a.entry);
    const allBullish = allRawBlocks
      .filter((b) => b.type === "bullish")
      .sort((a, b) => b.entry - a.entry);

    // 计算止损止盈
    for (const block of [...allBearish, ...allBullish]) {
      // 止损 = 边界，最大 200 点
      const boundary = block.type === "bearish" ? block.high : block.low;
      const slDistance = Math.abs(block.entry - boundary);

      if (slDistance > MAX_SL_DISTANCE) {
        block.stopLoss =
          block.type === "bearish"
            ? block.entry + MAX_SL_DISTANCE
            : block.entry - MAX_SL_DISTANCE;
      } else {
        block.stopLoss = boundary;
      }

      // 止盈 = 最近的对立塔块，最小 1000 点
      let target: typeof block | undefined;

      if (block.type === "bearish") {
        const candidates = allBullish.filter((b) => b.entry < block.entry);
        target = candidates[0];
      } else {
        const candidates = allBearish.filter((b) => b.entry > block.entry);
        target = candidates[candidates.length - 1];
      }

      if (target) {
        const tpDistance = Math.abs(target.entry - block.entry);
        if (tpDistance >= MIN_TP_DISTANCE) {
          block.takeProfit = target.entry;
        } else {
          block.takeProfit =
            block.type === "bearish"
              ? block.entry - MIN_TP_DISTANCE
              : block.entry + MIN_TP_DISTANCE;
        }
      } else {
        block.takeProfit =
          block.type === "bearish"
            ? block.entry - MIN_TP_DISTANCE
            : block.entry + MIN_TP_DISTANCE;
      }
    }

    // 最小距离（千分之三）
    const minDistance = currentPrice * MIN_DISTANCE_RATIO;

    // 筛选当前价格上下各 N 层的塔块（至少距离当前价格千分之三）
    const bullishBlocks = allBullish
      .filter((b) => b.entry < currentPrice && currentPrice - b.entry >= minDistance)
      .sort((a, b) => b.entry - a.entry)
      .slice(0, towerLayers);

    const bearishBlocks = allBearish
      .filter((b) => b.entry > currentPrice && b.entry - currentPrice >= minDistance)
      .sort((a, b) => a.entry - b.entry)
      .slice(0, towerLayers);

    const selectedBlocks = [...bullishBlocks, ...bearishBlocks];

    if (selectedBlocks.length === 0) {
      alert("没有符合条件的塔块");
      return;
    }

    const confirmed = confirm(
      `即将下 ${selectedBlocks.length} 个塔单\n` +
        `多塔: ${bullishBlocks.length} 个，空塔: ${bearishBlocks.length} 个\n` +
        `每单保证金: ${baseMargin} USDT\n` +
        `确定继续吗？`
    );

    if (!confirmed) return;

    setIsAutoOrdering(true);
    setOrderProgress({ current: 0, total: selectedBlocks.length, errors: [] });

    const errors: string[] = [];

    for (let i = 0; i < selectedBlocks.length; i++) {
      const block = selectedBlocks[i];
      const quantity = calculateQuantity(baseMargin, block.entry);

      try {
        const result = await placeOrder(
          {
            type: "limit",
            side: block.type === "bullish" ? "buy" : "sell",
            price: block.entry,
            stopPrice: block.stopLoss,
            takeProfit: block.takeProfit,
            quantity,
            clientOrderIdPrefix: "ict_tower",
          },
          symbol.replace("/", "")
        );

        if (!result.success) {
          errors.push(`${block.source} ${block.timeframe}: ${result.error}`);
        }
      } catch (err) {
        errors.push(
          `${block.source} ${block.timeframe}: ${err instanceof Error ? err.message : "未知错误"}`
        );
      }

      setOrderProgress({ current: i + 1, total: selectedBlocks.length, errors });

      // 添加小延迟避免请求过快
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    setIsAutoOrdering(false);

    if (errors.length > 0) {
      alert(`下单完成，但有 ${errors.length} 个错误:\n${errors.join("\n")}`);
    } else {
      alert(`成功下 ${selectedBlocks.length} 个塔单！`);
    }

    setOrderProgress(null);
  }, [data, towerLayers, baseMargin, calculateQuantity, placeOrder, symbol]);

  // 统计塔块数量和多空比例
  const stats = useMemo(() => {
    if (!data?.blocks) return { total: 0, bullish: 0, bearish: 0, ratio: "0:0" };

    const bullish = data.blocks.filter((b) => b.type === "bullish").length;
    const bearish = data.blocks.filter((b) => b.type === "bearish").length;
    const total = data.blocks.length;

    // 计算多空比例（简化为最简分数形式）
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const divisor = bullish > 0 && bearish > 0 ? gcd(bullish, bearish) : 1;
    const ratio =
      bullish === 0 && bearish === 0
        ? "0:0"
        : bullish === 0
        ? `0:${bearish}`
        : bearish === 0
        ? `${bullish}:0`
        : `${bullish / divisor}:${bearish / divisor}`;

    return { total, bullish, bearish, ratio };
  }, [data?.blocks]);

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
          {/* Stats Bar */}
          {data && data.blocks.length > 0 && (
            <div className="mb-4 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <div className="text-lg font-bold text-[var(--text-primary)]">
                      {stats.total}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)]">塔块总数</div>
                  </div>
                  <div className="h-8 w-px bg-[var(--border)]" />
                  <div className="text-center">
                    <div className="text-lg font-bold text-green-400">
                      {stats.bullish}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)]">多塔块</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-bold text-red-400">
                      {stats.bearish}
                    </div>
                    <div className="text-xs text-[var(--text-tertiary)]">空塔块</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium text-[var(--text-primary)]">
                    多空比 <span className="text-green-400">{stats.bullish}</span>
                    <span className="text-[var(--text-tertiary)]">:</span>
                    <span className="text-red-400">{stats.bearish}</span>
                  </div>
                  <div className="text-xs text-[var(--text-tertiary)]">
                    {stats.bullish > stats.bearish
                      ? "偏多"
                      : stats.bearish > stats.bullish
                      ? "偏空"
                      : "均衡"}
                  </div>
                </div>
              </div>
              {/* Progress Bar */}
              <div className="mt-2 h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden flex">
                {stats.total > 0 && (
                  <>
                    <div
                      className="h-full bg-green-500"
                      style={{ width: `${(stats.bullish / stats.total) * 100}%` }}
                    />
                    <div
                      className="h-full bg-red-500"
                      style={{ width: `${(stats.bearish / stats.total) * 100}%` }}
                    />
                  </>
                )}
              </div>
            </div>
          )}

          {/* Tower Settings */}
          <div className="mb-4 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              {/* 基础数量设置 */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-[var(--text-tertiary)]">
                  基础数量:
                </label>
                <input
                  type="number"
                  value={baseMargin}
                  onChange={(e) => handleMarginChange(Number(e.target.value))}
                  className="w-20 px-2 py-1 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                  min={10}
                  max={10000}
                  step={10}
                />
                <span className="text-xs text-[var(--text-tertiary)]">USDT</span>
              </div>

              {/* 守塔层数设置 */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-[var(--text-tertiary)]">
                  守塔层数:
                </label>
                <select
                  value={towerLayers}
                  onChange={(e) => handleLayersChange(Number(e.target.value))}
                  className="px-2 py-1 text-sm bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] focus:outline-none focus:border-blue-500"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} 层
                    </option>
                  ))}
                </select>
              </div>

              {/* 一键守塔按钮 */}
              <button
                onClick={handleAutoTower}
                disabled={isAutoOrdering || !data?.blocks?.length}
                className="px-4 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-500 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors flex items-center gap-2"
              >
                <span>🏯</span>
                {isAutoOrdering ? "下单中..." : "一键守塔"}
              </button>
            </div>

            {/* 下单进度 */}
            {orderProgress && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-[var(--text-tertiary)] mb-1">
                  <span>
                    下单进度: {orderProgress.current}/{orderProgress.total}
                  </span>
                  {orderProgress.errors.length > 0 && (
                    <span className="text-red-400">
                      {orderProgress.errors.length} 个错误
                    </span>
                  )}
                </div>
                <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{
                      width: `${(orderProgress.current / orderProgress.total) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Rules Summary */}
          <details className="mb-4 group">
            <summary className="p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] cursor-pointer list-none flex items-center justify-between hover:bg-[var(--bg-tertiary)] transition-colors">
              <span className="text-sm font-medium text-[var(--text-primary)]">
                塔块规则
              </span>
              <svg
                className="w-4 h-4 text-[var(--text-tertiary)] transition-transform group-open:rotate-180"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </summary>
            <div className="mt-2 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
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
          </details>

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
          <TowerOrderModal block={selectedBlock} onClose={handleCloseModal} defaultMargin={baseMargin} />
        )}
      </div>
    </AuthGuard>
  );
}
