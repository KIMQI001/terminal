"use client";

import { ChevronDown, Activity, Search, ArrowLeftRight, Ruler, Settings, User, Maximize2, Minimize2, BarChart3, Building2, Layers } from "lucide-react";
import { MTFPanel } from "@/components/chart/MTFPanel";
import { DailyHLPanel } from "@/components/chart/DailyHLPanel";
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
import { Timeframe } from "@/types/chart";
import { IndicatorState } from "@/types/indicator";
import { useState, useEffect, useCallback } from "react";

const timeframes: { value: Timeframe; label: string }[] = [
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
];

const indicators: { key: keyof IndicatorState; label: string }[] = [
  { key: "swingPoints", label: "Swing Points" },
  { key: "orderBlocks", label: "Order Blocks" },
  { key: "fvg", label: "FVG" },
  { key: "bos", label: "BOS" },
  { key: "choch", label: "CHoCH" },
  { key: "liquidityZones", label: "Liquidity" },
  { key: "killzones", label: "Killzones" },
  { key: "ote", label: "OTE" },
  { key: "breakerBlocks", label: "Breaker" },
  { key: "inducement", label: "Inducement" },
];

export function Header() {
  const { symbol, timeframe, setSymbol, setTimeframe } = useChartStore();
  const { enabled, toggleIndicator } = useIndicatorStore();
  const { isModalOpen, togglePanel } = useOrderStore();
  const { isToolActive, toggleToolActive } = useMeasurementStore();
  const { isAuthenticated, user, openSettings } = useUserStore();
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
    <header className="flex items-center justify-between h-12 px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
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

        {/* MTF Panel */}
        <MTFPanel />
        {/* Daily H/L Panel */}
        <DailyHLPanel />
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

        {/* 守塔策略按钮 */}
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

        {/* 滚仓策略按钮 */}
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

        {/* AI 分析按钮 */}
        <Link href="/analysis">
          <Button
            variant="outline"
            size="sm"
            title="AI 分析统计"
          >
            <BarChart3 className="w-3 h-3 mr-1.5" />
            分析
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
    </header>
  );
}
