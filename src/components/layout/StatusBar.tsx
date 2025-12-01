"use client";

import { useChartStore } from "@/stores/chartStore";
import { useQuery } from "@tanstack/react-query";
import { fetchTicker } from "@/lib/binance/api";
import { Wifi, WifiOff } from "lucide-react";

export function StatusBar() {
  const { symbol, isConnected, candles } = useChartStore();

  const { data: ticker } = useQuery({
    queryKey: ["ticker", symbol],
    queryFn: () => fetchTicker(symbol),
    refetchInterval: 5000,
  });

  const lastCandle = candles[candles.length - 1];
  const priceChange = ticker?.priceChangePercent
    ? parseFloat(ticker.priceChangePercent)
    : 0;
  const isPositive = priceChange >= 0;

  return (
    <footer className="flex items-center justify-between h-8 px-4 border-t border-[var(--border)] bg-[var(--bg-secondary)] text-xs">
      <div className="flex items-center gap-4">
        {/* Connection Status */}
        <div className="flex items-center gap-1.5">
          {isConnected ? (
            <>
              <Wifi className="w-3 h-3 text-[var(--connected)]" />
              <span className="text-[var(--connected)]">Connected</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3 h-3 text-[var(--disconnected)]" />
              <span className="text-[var(--disconnected)]">Disconnected</span>
            </>
          )}
        </div>

        {/* Symbol */}
        <span className="text-[var(--text-secondary)]">{symbol}</span>
      </div>

      <div className="flex items-center gap-6">
        {/* Last Price */}
        {lastCandle && (
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-secondary)]">Price:</span>
            <span
              className={isPositive ? "text-[var(--positive)]" : "text-[var(--negative)]"}
            >
              {lastCandle.close.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 8,
              })}
            </span>
          </div>
        )}

        {/* 24h Change */}
        {ticker && (
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-secondary)]">24h:</span>
            <span
              className={isPositive ? "text-[var(--positive)]" : "text-[var(--negative)]"}
            >
              {isPositive ? "+" : ""}
              {priceChange.toFixed(2)}%
            </span>
          </div>
        )}

        {/* Volume */}
        {ticker && (
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-secondary)]">Vol:</span>
            <span>
              {parseFloat(ticker.quoteVolume).toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
          </div>
        )}
      </div>
    </footer>
  );
}
