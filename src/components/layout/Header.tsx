"use client";

import { ChevronDown, Activity, Search, ArrowLeftRight, Ruler, Settings, User, Maximize2, Minimize2, Building2, Layers, Bot, BarChart3, LineChart, Rewind } from "lucide-react";
import { MTFPanel } from "@/components/chart/MTFPanel";
import { DailyHLPanel } from "@/components/chart/DailyHLPanel";
import { PriceModeToggle } from "@/components/chart/PriceModeToggle";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { useChartStore } from "@/stores/chartStore";
import { cn } from "@/lib/utils";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useOrderStore } from "@/stores/orderStore";
import { useMeasurementStore } from "@/stores/measurementStore";
import { useUserStore } from "@/stores/userStore";
import { useReplayStore } from "@/stores/replayStore";
import { Timeframe } from "@/types/chart";
import { IndicatorState } from "@/types/indicator";
import { useState, useEffect, useCallback } from "react";

const timeframes: { value: Timeframe; label: string }[] = [
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
  { value: "4d", label: "4D" },
];

const indicators: { key: keyof IndicatorState; label: string }[] = [
  { key: "swingPoints", label: "Swing Points" },
  { key: "swingRays", label: "Swing Rays" },
  { key: "orderBlocks", label: "Order Blocks" },
  { key: "fvg", label: "FVG" },
  { key: "bos", label: "BOS" },
  { key: "choch", label: "CHoCH" },
  { key: "liquidityZones", label: "Liquidity" },
  { key: "killzones", label: "Killzones" },
  { key: "ote", label: "OTE" },
  { key: "breakerBlocks", label: "Breaker" },
  { key: "inducement", label: "Inducement" },
  { key: "rejections", label: "Rejections" },
  { key: "proximitySignals", label: "Proximity Signal" },
  { key: "priceBand", label: "Price Band" },
];

export function Header({ showReplay = false }: { showReplay?: boolean }) {
  const { symbol, timeframe, setSymbol, setTimeframe } = useChartStore();
  const { enabled, toggleIndicator } = useIndicatorStore();
  const { isModalOpen, togglePanel, openModal } = useOrderStore();
  const { isToolActive, toggleToolActive } = useMeasurementStore();
  const { isAuthenticated, user, openSettings } = useUserStore();
  const isReplaying = useReplayStore((s) => s.isReplaying);
  const startReplay = useReplayStore((s) => s.startReplay);
  const stopReplay = useReplayStore((s) => s.stopReplay);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 监听全屏状态变化
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // 切换全屏
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }, []);

  const handleSymbolChange = (newSymbol: string) => {
    setSymbol(newSymbol.toUpperCase());
    setSearchOpen(false);
    setSearchQuery("");
  };

  return (
    <header
      className="h-12 border-b border-[var(--border)] bg-[var(--bg-secondary)] overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
      style={{ scrollbarWidth: 'none' }}
    >
      <div className="flex items-center justify-between min-w-max h-full px-4 gap-6">
        <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-[var(--accent)]" />
          <span className="font-semibold text-sm">Terminal</span>
        </div>

        {/* Symbol Search */}
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            className="w-32 justify-between"
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <span>{symbol}</span>
            <Search className="w-3 h-3 ml-2" />
          </Button>

          {searchOpen && (
            <div className="absolute top-full left-0 mt-1 w-48 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md shadow-lg z-50">
              <input
                type="text"
                placeholder="Search symbol..."
                className="w-full px-3 py-2 bg-transparent text-sm border-b border-[var(--border)] focus:outline-none"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchQuery) {
                    handleSymbolChange(searchQuery + "USDC");
                  }
                }}
                autoFocus
              />
              <div className="p-1 max-h-48 overflow-y-auto">
                {["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA"].map(
                  (base) => (
                    <button
                      key={base}
                      className="w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)] rounded"
                      onClick={() => handleSymbolChange(base + "USDC")}
                    >
                      {base}USDC
                    </button>
                  )
                )}
              </div>
            </div>
          )}
        </div>

        {/* Timeframe Selector */}
        <div className="flex items-center gap-1">
          {timeframes.map((tf) => (
            <Button
              key={tf.value}
              variant={timeframe === tf.value ? "default" : "ghost"}
              size="sm"
              className="px-2 h-7 text-xs"
              onClick={() => setTimeframe(tf.value)}
            >
              {tf.label}
            </Button>
          ))}
        </div>

        {/* 当前价 + K线显示模式(S/L) */}
        <PriceModeToggle />

        {/* MTF Panel */}
        <MTFPanel />
        {/* Daily H/L Panel */}
        <DailyHLPanel />

        {/* 图表类型切换 */}
        <Button
          variant={useChartStore.getState().chartType === "line" ? "default" : "outline"}
          size="sm"
          className={useChartStore.getState().chartType === "line" ? "bg-[var(--accent)] hover:bg-[var(--accent)]/90" : ""}
          onClick={() => useChartStore.getState().setChartType(useChartStore.getState().chartType === "candlestick" ? "line" : "candlestick")}
        >
          {useChartStore.getState().chartType === "candlestick" ? <LineChart className="w-3 h-3 mr-1" /> : <BarChart3 className="w-3 h-3 mr-1" />}
          {useChartStore.getState().chartType === "candlestick" ? "折线图" : "蜡烛图"}
        </Button>
      </div>

      {/* Tools & Trade & Indicators */}
      <div className="flex items-center gap-2">
        {/* 尺子按钮 */}
        <Button
          variant={isToolActive ? "default" : "outline"}
          size="sm"
          onClick={toggleToolActive}
          className={isToolActive ? "bg-indigo-500 hover:bg-indigo-600" : ""}
          title="测量工具 (或按住 Shift 拖动)"
        >
          <Ruler className="w-3 h-3" />
        </Button>

        {/* 回放模拟盘开关 */}
        {showReplay && (
          <Button
            data-testid="replay-toggle"
            variant={isReplaying ? "default" : "outline"}
            size="sm"
            onClick={() => {
              if (isReplaying) {
                stopReplay();
                return;
              }
              startReplay();
              // 回放模式：模拟下单表单只在右侧「交易」面板里 → 顺手打开它
              openModal();
            }}
            className={isReplaying ? "bg-orange-500 hover:bg-orange-600" : ""}
            title={isReplaying ? "退出回放模式" : "进入回放模拟盘(练习 K 线下单,不动真钱)"}
          >
            <Rewind className="w-3 h-3 mr-1.5" />
            回放
          </Button>
        )}

        {/* 交易按钮 */}
        <Button
          variant={isModalOpen ? "default" : "outline"}
          size="sm"
          onClick={togglePanel}
          className={isModalOpen ? "bg-[var(--accent)] hover:bg-[var(--accent)]/90" : ""}
        >
          <ArrowLeftRight className="w-3 h-3 mr-1.5" />
          交易
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <span>ICT Indicators</span>
              <ChevronDown className="w-3 h-3 ml-2" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {indicators.map((ind) => (
              <DropdownMenuItem
                key={ind.key}
                className="flex items-center justify-between"
                onClick={(e) => {
                  e.preventDefault();
                  toggleIndicator(ind.key);
                }}
              >
                <span>{ind.label}</span>
                <div
                  className={cn(
                    "w-8 h-4 rounded-full transition-colors",
                    enabled[ind.key]
                      ? "bg-[var(--bullish)]"
                      : "bg-[var(--bg-tertiary)]"
                  )}
                >
                  <div
                    className={cn(
                      "w-3 h-3 rounded-full bg-white shadow transition-transform mt-0.5",
                      enabled[ind.key] ? "translate-x-4 ml-0.5" : "translate-x-0.5"
                    )}
                  />
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 守塔策略按钮 (仅管理员) */}
        {user?.role === 'admin' && (
          <Link href="/tower">
            <Button
              variant="outline"
              size="sm"
              title="守塔策略"
            >
              <Building2 className="w-3 h-3 mr-1.5" />
              塔
            </Button>
          </Link>
        )}

        {/* 滚仓策略按钮 (仅管理员) */}
        {user?.role === 'admin' && (
          <Link href="/rolling">
            <Button
              variant="outline"
              size="sm"
              title="滚仓策略"
            >
              <Layers className="w-3 h-3 mr-1.5" />
              仓
            </Button>
          </Link>
        )}

        {/* AI 助手按钮 */}
        <Link href="/ai">
          <Button
            variant="outline"
            size="sm"
            title="AI 助手"
          >
            <Bot className="w-3 h-3 mr-1.5" />
            AI
          </Button>
        </Link>

        {/* 全屏按钮 */}
        <Button
          variant="outline"
          size="sm"
          onClick={toggleFullscreen}
          title={isFullscreen ? "退出全屏" : "全屏显示"}
        >
          {isFullscreen ? (
            <Minimize2 className="w-3 h-3" />
          ) : (
            <Maximize2 className="w-3 h-3" />
          )}
        </Button>

        {/* 用户/设置按钮 */}
        <Button
          variant="outline"
          size="sm"
          onClick={openSettings}
          className={isAuthenticated ? "text-green-600" : ""}
        >
          {isAuthenticated ? (
            <>
              <User className="w-3 h-3 mr-1.5" />
              <span className="max-w-16 truncate">{user?.username}</span>
            </>
          ) : (
            <>
              <Settings className="w-3 h-3 mr-1.5" />
              设置
            </>
          )}
        </Button>
      </div>
      </div>
    </header>
  );
}
