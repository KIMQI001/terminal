"use client";

import { ChevronDown, Activity, Search, ArrowLeftRight, Ruler } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { Toggle } from "@/components/ui/toggle";
import { useChartStore } from "@/stores/chartStore";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useOrderStore } from "@/stores/orderStore";
import { useMeasurementStore } from "@/stores/measurementStore";
import { Timeframe } from "@/types/chart";
import { IndicatorState } from "@/types/indicator";
import { useState } from "react";

const timeframes: { value: Timeframe; label: string }[] = [
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
];

const indicators: { key: keyof IndicatorState; label: string }[] = [
  { key: "orderBlocks", label: "Order Blocks" },
  { key: "fvg", label: "FVG" },
  { key: "bos", label: "BOS" },
  { key: "choch", label: "CHoCH" },
  { key: "liquidityZones", label: "Liquidity" },
  { key: "killzones", label: "Killzones" },
];

export function Header() {
  const { symbol, timeframe, setSymbol, setTimeframe } = useChartStore();
  const { enabled, toggleIndicator } = useIndicatorStore();
  const { isPanelOpen, togglePanel } = useOrderStore();
  const { isToolActive, toggleToolActive } = useMeasurementStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

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
          variant={isPanelOpen ? "default" : "outline"}
          size="sm"
          onClick={togglePanel}
          className={isPanelOpen ? "bg-[var(--accent)] hover:bg-[var(--accent)]/90" : ""}
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
                <Toggle
                  pressed={enabled[ind.key]}
                  size="sm"
                  className="h-5 w-8 data-[state=on]:bg-[var(--bullish)]"
                />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
