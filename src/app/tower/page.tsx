"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { TowerList, TowerOrderModal } from "@/components/tower";
import { TowerBlock } from "@/components/tower/types";
import { fetchTowerBlocks, TowerBlocksResult } from "@/lib/analysis/api";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore } from "@/stores/orderStore";
import { usePositionStore } from "@/stores/positionStore";
import { useUserStore } from "@/stores/userStore";

// localStorage keys
const STORAGE_KEYS = {
  BASE_MARGIN: "tower_base_margin",
  TOWER_LAYERS: "tower_layers",
  MARGIN_INCREMENT: "tower_margin_increment",
  BULLISH_START_LAYER: "tower_bullish_start",
  BEARISH_START_LAYER: "tower_bearish_start",
  MIN_SPACING_RATIO: "tower_min_spacing",
  AUTO_INTERVAL: "tower_auto_interval",
};

// 托管间隔选项（分钟）
const AUTO_INTERVALS = [
  { value: 0, label: "关闭" },
  { value: 5, label: "5分钟" },
  { value: 10, label: "10分钟" },
  { value: 15, label: "15分钟" },
  { value: 30, label: "30分钟" },
  { value: 60, label: "1小时" },
];

// 数据新鲜度阈值（毫秒）- 5分钟
const DATA_FRESHNESS_THRESHOLD = 5 * 60 * 1000;

// 后端托管状态接口
interface TowerManagementConfig {
  id: number;
  userId: number;
  symbol: string;
  isActive: boolean;
  intervalMinutes: number;
  baseMargin: number;
  marginIncrement: number;
  towerLayers: number;
  bullishStartLayer: number;
  bearishStartLayer: number;
  minSpacingRatio: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TowerManagementRecord {
  id: number;
  managementId: number;
  executedAt: string;
  status: "success" | "failed" | "skipped";
  bullishCount: number;
  bearishCount: number;
  totalMargin: number;
  errorMessage: string | null;
}

interface TowerManagementResponse {
  success: boolean;
  management: TowerManagementConfig | null;
  records: TowerManagementRecord[];
  stats: {
    totalExecutions: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
  };
}

// 守塔战绩记录（本地 UI 用）
interface TowerRecord {
  time: Date;
  bullishCount: number;
  bearishCount: number;
  totalMargin: number;
  success: boolean;
  errors: string[];
}

export default function TowerPage() {
  const { symbol } = useChartStore();
  const { placeOrder, cancelAllOrders } = useOrderStore();
  const { currentLeverage, fetchLeverage } = usePositionStore();
  const { user } = useUserStore();
  const queryClient = useQueryClient();
  const [selectedBlock, setSelectedBlock] = useState<TowerBlock | null>(null);

  // 设置状态
  const [baseMargin, setBaseMargin] = useState(100);
  const [marginIncrement, setMarginIncrement] = useState(0);
  const [towerLayers, setTowerLayers] = useState(3);
  const [bullishStartLayer, setBullishStartLayer] = useState(1);
  const [bearishStartLayer, setBearishStartLayer] = useState(1);
  const [minSpacingRatio, setMinSpacingRatio] = useState(5); // 万分之几，默认5（万分之五）
  const [autoInterval, setAutoInterval] = useState(5); // 托管间隔（分钟），默认5分钟
  const [isAutoOrdering, setIsAutoOrdering] = useState(false);
  const [orderProgress, setOrderProgress] = useState<{
    current: number;
    total: number;
    errors: string[];
  } | null>(null);

  // 守塔战绩状态（本地一键守塔用）
  const [towerRecords, setTowerRecords] = useState<TowerRecord[]>([]);
  const [towerStats, setTowerStats] = useState({ success: 0, failed: 0 });

  // 从后端获取托管状态
  const { data: managementData, refetch: refetchManagement } = useQuery<TowerManagementResponse>({
    queryKey: ["tower-management", user?.id, symbol],
    queryFn: async () => {
      if (!user?.id) throw new Error("未登录");
      const symbolFormatted = symbol.replace("/", "");
      const response = await fetch(`/api/analysis/tower-management?userId=${user.id}&symbol=${symbolFormatted}`);
      return response.json();
    },
    enabled: !!user?.id,
    refetchInterval: 30000, // 每 30 秒刷新一次托管状态
  });

  // 后端托管状态
  const isAutoManaged = managementData?.management?.isActive ?? false;
  const nextAutoTime = managementData?.management?.nextRunAt
    ? new Date(managementData.management.nextRunAt)
    : null;
  const backendRecords = managementData?.records ?? [];
  const backendStats = managementData?.stats ?? { totalExecutions: 0, successCount: 0, failedCount: 0, skippedCount: 0 };

  // 启动托管 mutation
  const startManagementMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("未登录");
      const symbolFormatted = symbol.replace("/", "");
      const response = await fetch("/api/analysis/tower-management/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          symbol: symbolFormatted,
          intervalMinutes: autoInterval,
          baseMargin,
          marginIncrement,
          towerLayers,
          bullishStartLayer,
          bearishStartLayer,
          minSpacingRatio,
        }),
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tower-management", user?.id, symbol] });
    },
  });

  // 停止托管 mutation
  const stopManagementMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("未登录");
      const symbolFormatted = symbol.replace("/", "");
      const response = await fetch("/api/analysis/tower-management/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          symbol: symbolFormatted,
        }),
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tower-management", user?.id, symbol] });
    },
  });

  // 从后端加载托管配置（优先），如果没有则用 localStorage
  useEffect(() => {
    if (managementData?.management) {
      // 后端有配置，使用后端的参数
      const config = managementData.management;
      setBaseMargin(config.baseMargin);
      setMarginIncrement(config.marginIncrement);
      setTowerLayers(config.towerLayers);
      setBullishStartLayer(config.bullishStartLayer);
      setBearishStartLayer(config.bearishStartLayer);
      setMinSpacingRatio(config.minSpacingRatio);
      setAutoInterval(config.intervalMinutes);
      // 同步到 localStorage
      localStorage.setItem(STORAGE_KEYS.BASE_MARGIN, String(config.baseMargin));
      localStorage.setItem(STORAGE_KEYS.MARGIN_INCREMENT, String(config.marginIncrement));
      localStorage.setItem(STORAGE_KEYS.TOWER_LAYERS, String(config.towerLayers));
      localStorage.setItem(STORAGE_KEYS.BULLISH_START_LAYER, String(config.bullishStartLayer));
      localStorage.setItem(STORAGE_KEYS.BEARISH_START_LAYER, String(config.bearishStartLayer));
      localStorage.setItem(STORAGE_KEYS.MIN_SPACING_RATIO, String(config.minSpacingRatio));
      localStorage.setItem(STORAGE_KEYS.AUTO_INTERVAL, String(config.intervalMinutes));
    } else if (managementData === undefined) {
      // 还在加载中，先从 localStorage 加载
      const savedMargin = localStorage.getItem(STORAGE_KEYS.BASE_MARGIN);
      const savedIncrement = localStorage.getItem(STORAGE_KEYS.MARGIN_INCREMENT);
      const savedLayers = localStorage.getItem(STORAGE_KEYS.TOWER_LAYERS);
      const savedBullishStart = localStorage.getItem(STORAGE_KEYS.BULLISH_START_LAYER);
      const savedBearishStart = localStorage.getItem(STORAGE_KEYS.BEARISH_START_LAYER);
      const savedSpacing = localStorage.getItem(STORAGE_KEYS.MIN_SPACING_RATIO);
      const savedAutoInterval = localStorage.getItem(STORAGE_KEYS.AUTO_INTERVAL);

      if (savedMargin) setBaseMargin(Number(savedMargin));
      if (savedIncrement) setMarginIncrement(Number(savedIncrement));
      if (savedLayers) setTowerLayers(Number(savedLayers));
      if (savedBullishStart) setBullishStartLayer(Number(savedBullishStart));
      if (savedBearishStart) setBearishStartLayer(Number(savedBearishStart));
      if (savedSpacing) setMinSpacingRatio(Number(savedSpacing));
      if (savedAutoInterval) setAutoInterval(Number(savedAutoInterval));
    }
    // 如果 managementData.management === null，说明后端没有配置，保持默认值
  }, [managementData]);

  // 保存设置到 localStorage
  const handleMarginChange = (value: number) => {
    setBaseMargin(value);
    localStorage.setItem(STORAGE_KEYS.BASE_MARGIN, String(value));
  };

  const handleIncrementChange = (value: number) => {
    setMarginIncrement(value);
    localStorage.setItem(STORAGE_KEYS.MARGIN_INCREMENT, String(value));
  };

  const handleLayersChange = (value: number) => {
    setTowerLayers(value);
    localStorage.setItem(STORAGE_KEYS.TOWER_LAYERS, String(value));
  };

  const handleBullishStartChange = (value: number) => {
    setBullishStartLayer(value);
    localStorage.setItem(STORAGE_KEYS.BULLISH_START_LAYER, String(value));
  };

  const handleBearishStartChange = (value: number) => {
    setBearishStartLayer(value);
    localStorage.setItem(STORAGE_KEYS.BEARISH_START_LAYER, String(value));
  };

  const handleSpacingChange = (value: number) => {
    setMinSpacingRatio(value);
    localStorage.setItem(STORAGE_KEYS.MIN_SPACING_RATIO, String(value));
  };

  const handleAutoIntervalChange = (value: number) => {
    setAutoInterval(value);
    localStorage.setItem(STORAGE_KEYS.AUTO_INTERVAL, String(value));
    // 注意：托管间隔变更需要重新启动托管才会生效
  };

  // 启动/停止托管（调用后端 API）
  const handleToggleAutoManage = () => {
    if (isAutoManaged) {
      // 停止托管
      stopManagementMutation.mutate();
    } else {
      // 启动托管
      if (autoInterval > 0) {
        startManagementMutation.mutate();
      }
    }
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

  // 检查数据是否过期（超过5分钟）
  const isDataStale = useCallback(() => {
    if (!data?.timestamp) return true;
    const dataTime = new Date(data.timestamp).getTime();
    const now = Date.now();
    return now - dataTime > DATA_FRESHNESS_THRESHOLD;
  }, [data?.timestamp]);

  // 确保数据新鲜后再执行回调
  const ensureFreshData = useCallback(async (): Promise<boolean> => {
    if (!isDataStale()) {
      return true;
    }
    console.log("[守塔] 数据过期，先刷新数据...");
    try {
      await refetch();
      // 等待数据更新
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return true;
    } catch (err) {
      console.error("[守塔] 刷新数据失败:", err);
      return false;
    }
  }, [isDataStale, refetch]);

  // 一键守塔（silent=true 时不弹窗，用于托管模式）
  const handleAutoTower = useCallback(async (silent = false) => {
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
    // 最小间距（万分之 N）
    const minSpacing = currentPrice * (minSpacingRatio / 10000);

    // 筛选函数：保证相邻塔块间距 >= minSpacing
    const filterWithSpacing = (
      blocks: typeof allBullish,
      startLayer: number,
      count: number
    ) => {
      const result: typeof blocks = [];
      let skipped = 0;
      let lastEntry: number | null = null;

      for (const block of blocks) {
        // 检查与上一个选中塔块的间距
        if (lastEntry !== null) {
          const spacing = Math.abs(block.entry - lastEntry);
          if (spacing < minSpacing) {
            continue; // 间距不足，跳过
          }
        }

        // 处理起始层跳过
        if (skipped < startLayer - 1) {
          skipped++;
          continue;
        }

        result.push(block);
        lastEntry = block.entry;

        if (result.length >= count) break;
      }

      return result;
    };

    // 筛选当前价格上下各 N 层的塔块（至少距离当前价格千分之三）
    // 起始层：跳过前 N-1 层，从第 N 层开始
    // 间距过滤：相邻塔块间距 >= minSpacing
    const bullishCandidates = allBullish
      .filter((b) => b.entry < currentPrice && currentPrice - b.entry >= minDistance)
      .sort((a, b) => b.entry - a.entry); // 从高到低（离当前价格近的在前）

    const bearishCandidates = allBearish
      .filter((b) => b.entry > currentPrice && b.entry - currentPrice >= minDistance)
      .sort((a, b) => a.entry - b.entry); // 从低到高（离当前价格近的在前）

    const bullishBlocks = filterWithSpacing(bullishCandidates, bullishStartLayer, towerLayers);
    const bearishBlocks = filterWithSpacing(bearishCandidates, bearishStartLayer, towerLayers);

    const selectedBlocks = [...bullishBlocks, ...bearishBlocks];

    if (selectedBlocks.length === 0) {
      if (!silent) alert("没有符合条件的塔块");
      return;
    }

    // 计算总保证金（考虑递增）
    const calcTotalMargin = (count: number) => {
      let total = 0;
      for (let i = 0; i < count; i++) {
        total += baseMargin + i * marginIncrement;
      }
      return total;
    };
    const totalMargin = calcTotalMargin(bullishBlocks.length) + calcTotalMargin(bearishBlocks.length);

    // 非静默模式下弹窗确认
    if (!silent) {
      const confirmed = confirm(
        `即将下 ${selectedBlocks.length} 个塔单\n` +
          `多塔: ${bullishBlocks.length} 个（第${bullishStartLayer}层起），空塔: ${bearishBlocks.length} 个（第${bearishStartLayer}层起）\n` +
          `基础保证金: ${baseMargin} USDT，递增: ${marginIncrement} USDT\n` +
          `总保证金: ${totalMargin} USDT\n` +
          `确定继续吗？`
      );

      if (!confirmed) return;
    } else {
      console.log(`[托管] 下单: ${selectedBlocks.length} 个塔单，总保证金: ${totalMargin} USDT`);
    }

    setIsAutoOrdering(true);
    setOrderProgress({ current: 0, total: selectedBlocks.length, errors: [] });

    const errors: string[] = [];

    // 分别处理多空，按层递增保证金
    // bullishBlocks 已按 entry 从高到低排序（离当前价格近的在前）
    // bearishBlocks 已按 entry 从低到高排序（离当前价格近的在前）
    const ordersToPlace: Array<{
      block: typeof selectedBlocks[0];
      margin: number;
    }> = [];

    for (let i = 0; i < bullishBlocks.length; i++) {
      ordersToPlace.push({
        block: bullishBlocks[i],
        margin: baseMargin + i * marginIncrement,
      });
    }

    for (let i = 0; i < bearishBlocks.length; i++) {
      ordersToPlace.push({
        block: bearishBlocks[i],
        margin: baseMargin + i * marginIncrement,
      });
    }

    for (let i = 0; i < ordersToPlace.length; i++) {
      const { block, margin } = ordersToPlace[i];
      const quantity = calculateQuantity(margin, block.entry);

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

      setOrderProgress({ current: i + 1, total: ordersToPlace.length, errors });

      // 添加小延迟避免请求过快
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    setIsAutoOrdering(false);

    // 记录战绩
    const record: TowerRecord = {
      time: new Date(),
      bullishCount: bullishBlocks.length,
      bearishCount: bearishBlocks.length,
      totalMargin,
      success: errors.length === 0,
      errors,
    };
    setTowerRecords(prev => [record, ...prev].slice(0, 20)); // 最多保留20条记录
    setTowerStats(prev => ({
      success: prev.success + (errors.length === 0 ? 1 : 0),
      failed: prev.failed + (errors.length > 0 ? 1 : 0),
    }));

    // 非静默模式下显示结果
    if (!silent) {
      if (errors.length > 0) {
        alert(`下单完成，但有 ${errors.length} 个错误:\n${errors.join("\n")}`);
      } else {
        alert(`成功下 ${ordersToPlace.length} 个塔单！`);
      }
    } else {
      if (errors.length > 0) {
        console.error(`[托管] 下单完成，但有 ${errors.length} 个错误:`, errors);
      } else {
        console.log(`[托管] 成功下 ${ordersToPlace.length} 个塔单`);
      }
    }

    setOrderProgress(null);
  }, [data, towerLayers, bullishStartLayer, bearishStartLayer, minSpacingRatio, baseMargin, marginIncrement, calculateQuantity, placeOrder, symbol]);

  // 更新守塔：取消所有订单后重新下单
  const handleRefreshTower = useCallback(async () => {
    // 检查数据新鲜度
    const stale = isDataStale();
    const confirmMsg = stale
      ? `数据已过期，将先刷新数据\n然后取消 ${symbol.replace("/", "")} 的所有挂单，重新下守塔单\n确定继续吗？`
      : `将取消 ${symbol.replace("/", "")} 的所有挂单，然后重新下守塔单\n确定继续吗？`;

    const confirmed = confirm(confirmMsg);
    if (!confirmed) return;

    setIsAutoOrdering(true);
    setOrderProgress({ current: 0, total: 1, errors: [] });

    // 0. 如需刷新数据
    if (stale) {
      const dataFresh = await ensureFreshData();
      if (!dataFresh) {
        alert("刷新数据失败，请稍后重试");
        setIsAutoOrdering(false);
        setOrderProgress(null);
        return;
      }
    }

    // 1. 取消所有订单
    const cancelSuccess = await cancelAllOrders(symbol.replace("/", ""));
    if (!cancelSuccess) {
      alert("取消订单失败");
      setIsAutoOrdering(false);
      setOrderProgress(null);
      return;
    }

    // 等待一下确保订单取消完成
    await new Promise((resolve) => setTimeout(resolve, 500));

    setIsAutoOrdering(false);
    setOrderProgress(null);

    // 2. 重新下单
    handleAutoTower();
  }, [symbol, cancelAllOrders, handleAutoTower, isDataStale, ensureFreshData]);

  // 托管由后端 analysis-service 定时执行，前端只显示状态
  // 不再需要本地定时器和相关函数

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
          <div className="mb-4 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] space-y-2">
            {/* 第一行：保证金和层数设置 */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1">
                <span className="text-xs text-[var(--text-tertiary)]">保证金</span>
                <input
                  type="number"
                  value={baseMargin}
                  onChange={(e) => handleMarginChange(Number(e.target.value))}
                  className="w-14 px-1.5 py-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-center focus:outline-none focus:border-blue-500"
                  min={10}
                  max={10000}
                  step={10}
                />
                <span className="text-xs text-[var(--text-tertiary)]">+</span>
                <input
                  type="number"
                  value={marginIncrement}
                  onChange={(e) => handleIncrementChange(Number(e.target.value))}
                  className="w-12 px-1.5 py-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-center focus:outline-none focus:border-blue-500"
                  min={0}
                  max={1000}
                  step={5}
                />
                <span className="text-xs text-[var(--text-tertiary)]">U/层</span>
              </div>

              <div className="h-4 w-px bg-[var(--border)]" />

              <div className="flex items-center gap-1">
                <span className="text-xs text-[var(--text-tertiary)]">层数</span>
                <select
                  value={towerLayers}
                  onChange={(e) => handleLayersChange(Number(e.target.value))}
                  className="w-12 px-1 py-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-center focus:outline-none focus:border-blue-500"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1">
                <span className="text-xs text-green-500">多起</span>
                <select
                  value={bullishStartLayer}
                  onChange={(e) => handleBullishStartChange(Number(e.target.value))}
                  className="w-10 px-1 py-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-center focus:outline-none focus:border-blue-500"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1">
                <span className="text-xs text-red-500">空起</span>
                <select
                  value={bearishStartLayer}
                  onChange={(e) => handleBearishStartChange(Number(e.target.value))}
                  className="w-10 px-1 py-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-center focus:outline-none focus:border-blue-500"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1">
                <span className="text-xs text-[var(--text-tertiary)]">间距</span>
                <select
                  value={minSpacingRatio}
                  onChange={(e) => handleSpacingChange(Number(e.target.value))}
                  className="w-14 px-1 py-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-center focus:outline-none focus:border-blue-500"
                >
                  {[0, 3, 5, 8, 10, 15, 20].map((n) => (
                    <option key={n} value={n}>{n}‱</option>
                  ))}
                </select>
              </div>
            </div>

            {/* 第二行：操作按钮 */}
            <div className="flex items-center gap-2 pt-1 border-t border-[var(--border)]">
              {/* 守塔按钮 */}
              <button
                onClick={() => handleAutoTower(false)}
                disabled={isAutoOrdering || !data?.blocks?.length}
                className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-500 disabled:cursor-not-allowed text-white text-xs font-medium rounded transition-colors"
              >
                {isAutoOrdering ? "下单中..." : "🏯 守塔"}
              </button>

              {/* 更新按钮 */}
              <button
                onClick={handleRefreshTower}
                disabled={isAutoOrdering || !data?.blocks?.length}
                className="px-2 py-1.5 bg-orange-500 hover:bg-orange-600 disabled:bg-gray-500 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
                title="取消所有订单并重新下单"
              >
                🔄 更新
              </button>

              <div className="h-5 w-px bg-[var(--border)]" />

              {/* 托管设置 */}
              <div className="flex items-center gap-1.5">
                <select
                  value={autoInterval}
                  onChange={(e) => handleAutoIntervalChange(Number(e.target.value))}
                  disabled={isAutoManaged}
                  className="w-16 px-1 py-1.5 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-center focus:outline-none focus:border-blue-500 disabled:opacity-60"
                >
                  {AUTO_INTERVALS.filter(opt => opt.value > 0).map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>

                <button
                  onClick={handleToggleAutoManage}
                  disabled={isAutoOrdering || !data?.blocks?.length}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                    isAutoManaged
                      ? "bg-green-500 hover:bg-green-600 text-white"
                      : "bg-[var(--bg-tertiary)] hover:bg-[var(--bg-primary)] text-[var(--text-secondary)] border border-[var(--border)]"
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {isAutoManaged ? "⏹ 停止托管" : "▶ 启动托管"}
                </button>
              </div>

              {/* 托管状态 */}
              {isAutoManaged && nextAutoTime && (
                <span className="text-xs text-green-400 ml-auto">
                  下次: {nextAutoTime.toLocaleTimeString("zh-CN")}
                </span>
              )}
            </div>
            {/* 下单进度 */}
            {orderProgress && (
              <div>
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

          {/* 守塔战绩面板 - 托管时显示 */}
          {isAutoManaged && (
            <div className="mb-4 p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-[var(--text-primary)]">
                  🏯 守塔战绩 <span className="text-xs font-normal text-green-400">(后台运行中)</span>
                </h3>
                <div className="flex items-center gap-3">
                  <span className="text-xs">
                    <span className="text-green-400">{backendStats.successCount}</span>
                    <span className="text-[var(--text-tertiary)]"> 成功</span>
                  </span>
                  <span className="text-xs">
                    <span className="text-red-400">{backendStats.failedCount}</span>
                    <span className="text-[var(--text-tertiary)]"> 失败</span>
                  </span>
                  <span className="text-xs">
                    <span className="text-yellow-400">{backendStats.skippedCount}</span>
                    <span className="text-[var(--text-tertiary)]"> 跳过</span>
                  </span>
                  {backendStats.totalExecutions > 0 && (
                    <span className="text-xs text-[var(--text-tertiary)]">
                      ({Math.round((backendStats.successCount / backendStats.totalExecutions) * 100)}%)
                    </span>
                  )}
                </div>
              </div>

              {/* 记录列表 */}
              {backendRecords.length === 0 ? (
                <div className="text-xs text-[var(--text-tertiary)] text-center py-4">
                  托管已启动，等待首次执行...
                </div>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {backendRecords.map((record) => (
                    <div
                      key={record.id}
                      className={`flex items-center justify-between px-2 py-1.5 rounded text-xs ${
                        record.status === "success"
                          ? "bg-green-500/10 border border-green-500/20"
                          : record.status === "skipped"
                          ? "bg-yellow-500/10 border border-yellow-500/20"
                          : "bg-red-500/10 border border-red-500/20"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={
                          record.status === "success"
                            ? "text-green-400"
                            : record.status === "skipped"
                            ? "text-yellow-400"
                            : "text-red-400"
                        }>
                          {record.status === "success" ? "✓" : record.status === "skipped" ? "⏭" : "✗"}
                        </span>
                        <span className="text-[var(--text-tertiary)]">
                          {new Date(record.executedAt).toLocaleTimeString("zh-CN")}
                        </span>
                        <span className="text-[var(--text-secondary)]">
                          <span className="text-green-400">{record.bullishCount}多</span>
                          {" / "}
                          <span className="text-red-400">{record.bearishCount}空</span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[var(--text-tertiary)]">
                          {record.totalMargin}U
                        </span>
                        {record.errorMessage && (
                          <span className="text-red-400" title={record.errorMessage}>
                            有错误
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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
