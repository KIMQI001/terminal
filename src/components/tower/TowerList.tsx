"use client";

import { useMemo } from "react";
import { TowerCard } from "./TowerCard";
import { TowerBlock } from "./types";
import { TowerBlockData } from "@/lib/analysis/api";

interface TowerListProps {
  currentPrice: number;
  blocks: TowerBlockData[];
}

const MAX_SL_DISTANCE = 200; // Maximum stop loss distance in points
const MIN_TP_DISTANCE = 1000; // Minimum take profit distance in points

export function TowerList({ currentPrice, blocks }: TowerListProps) {
  const { bearishBlocks, bullishBlocks } = useMemo(() => {
    // Convert API blocks to TowerBlocks with SL/TP calculations
    const towerBlocks: TowerBlock[] = blocks.map((b) => ({
      id: b.id,
      type: b.type,
      source: b.source,
      timeframe: b.timeframe,
      high: b.high,
      low: b.low,
      entry: b.entry,
      stopLoss: 0, // Will be calculated
      takeProfit: 0, // Will be calculated
      riskReward: 0, // Will be calculated
      fillPercent: b.fillPercent,
    }));

    // Separate into bearish and bullish
    const bearish = towerBlocks
      .filter((b) => b.type === "bearish")
      .sort((a, b) => b.entry - a.entry); // Higher first
    const bullish = towerBlocks
      .filter((b) => b.type === "bullish")
      .sort((a, b) => b.entry - a.entry); // Higher first

    // Calculate stop loss and take profit
    for (const block of [...bearish, ...bullish]) {
      // Stop loss = boundary, max 200 points
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

      // Take profit = first opposite block, min 1000 points
      const oppositeBlocks = block.type === "bearish" ? bullish : bearish;
      const target = oppositeBlocks.find((b) =>
        block.type === "bearish" ? b.entry < block.entry : b.entry > block.entry
      );

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

      // Calculate risk/reward
      const risk = Math.abs(block.stopLoss - block.entry);
      const reward = Math.abs(block.takeProfit - block.entry);
      block.riskReward = risk > 0 ? reward / risk : 0;
    }

    return { bearishBlocks: bearish, bullishBlocks: bullish };
  }, [blocks]);

  const formatPrice = (price: number) => {
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  return (
    <div className="space-y-4">
      {/* Bearish blocks (above price) */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="h-px flex-1 bg-red-500/30" />
          <span className="text-xs font-medium text-red-400 px-2">
            空塔块（做空入场）
          </span>
          <div className="h-px flex-1 bg-red-500/30" />
        </div>

        {bearishBlocks.length > 0 ? (
          <div className="space-y-2">
            {bearishBlocks.map((block) => (
              <TowerCard key={block.id} block={block} />
            ))}
          </div>
        ) : (
          <div className="text-center text-xs text-[var(--text-tertiary)] py-4">
            暂无符合条件的空塔块
          </div>
        )}
      </div>

      {/* Current price divider */}
      <div className="relative py-4">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t-2 border-dashed border-blue-500/50" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-[var(--bg-primary)] px-4 py-1.5 text-sm font-bold text-blue-400 border border-blue-500/30 rounded-full">
            当前价格 ${formatPrice(currentPrice)}
          </span>
        </div>
      </div>

      {/* Bullish blocks (below price) */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="h-px flex-1 bg-green-500/30" />
          <span className="text-xs font-medium text-green-400 px-2">
            多塔块（做多入场）
          </span>
          <div className="h-px flex-1 bg-green-500/30" />
        </div>

        {bullishBlocks.length > 0 ? (
          <div className="space-y-2">
            {bullishBlocks.map((block) => (
              <TowerCard key={block.id} block={block} />
            ))}
          </div>
        ) : (
          <div className="text-center text-xs text-[var(--text-tertiary)] py-4">
            暂无符合条件的多塔块
          </div>
        )}
      </div>
    </div>
  );
}
