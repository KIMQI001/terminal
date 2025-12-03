"use client";

import { useMemo } from "react";
import { FVG, OrderBlock } from "@/types/indicator";
import { OTEZone } from "@/lib/chart/indicators/ote";
import { TowerCard } from "./TowerCard";
import { TowerBlock } from "./types";
import { Timeframe } from "@/types/chart";

type MultiTimeframeFVG = {
  [key in '5m' | '15m' | '1h' | '4h' | '1d' | '1w']: FVG | null;
};

type MultiTimeframeOB = {
  [key in '5m' | '15m' | '1h' | '4h' | '1d' | '1w']: OrderBlock | null;
};

type MultiTimeframeOTE = {
  [key in '5m' | '15m' | '1h' | '4h' | '1d' | '1w']: OTEZone | null;
};

interface TowerListProps {
  currentPrice: number;
  multiTimeframeFVG: MultiTimeframeFVG;
  multiTimeframeOB: MultiTimeframeOB;
  multiTimeframeOTE: MultiTimeframeOTE;
}

const TIMEFRAMES: Array<'5m' | '15m' | '1h' | '4h' | '1d'> = ["5m", "15m", "1h", "4h", "1d"];
const MAX_SL_DISTANCE = 200; // Maximum stop loss distance in points
const MIN_TP_DISTANCE = 1000; // Minimum take profit distance in points
const MAX_FILL_PERCENT = 22; // Maximum fill percentage for FVG and OTE

export function TowerList({
  currentPrice,
  multiTimeframeFVG,
  multiTimeframeOB,
  multiTimeframeOTE,
}: TowerListProps) {
  const { bearishBlocks, bullishBlocks } = useMemo(() => {
    const blocks: TowerBlock[] = [];

    // Collect all tower blocks from all timeframes
    for (const tf of TIMEFRAMES) {
      const fvg = multiTimeframeFVG[tf];
      const ob = multiTimeframeOB[tf];
      const ote = multiTimeframeOTE[tf];

      // FVG: fillPercentage < 22%
      if (fvg && fvg.fillPercentage < MAX_FILL_PERCENT) {
        blocks.push({
          id: `fvg-${tf}-${fvg.time}`,
          type: fvg.type,
          source: "FVG",
          timeframe: tf,
          high: fvg.high,
          low: fvg.low,
          entry: fvg.fib22,
          stopLoss: 0, // Will be calculated
          takeProfit: 0, // Will be calculated
          riskReward: 0, // Will be calculated
          fillPercent: fvg.fillPercentage,
        });
      }

      // OB: No fill limit
      if (ob && !ob.mitigated) {
        blocks.push({
          id: `ob-${tf}-${ob.startTime}`,
          type: ob.type,
          source: "OB",
          timeframe: tf,
          high: ob.high,
          low: ob.low,
          entry: ob.fib22,
          stopLoss: 0,
          takeProfit: 0,
          riskReward: 0,
          fillPercent: ob.fillPercentage,
        });
      }

      // OTE: fillPercent < 22% (we need to calculate it)
      if (ote && ote.active) {
        // Calculate OTE fill percentage
        const zoneHeight = ote.fib618 - ote.fib786;
        let fillPercent = 0;
        if (zoneHeight > 0) {
          if (ote.type === "bullish") {
            // For bullish OTE, price enters from above
            if (currentPrice >= ote.fib618) {
              fillPercent = 0;
            } else if (currentPrice <= ote.fib786) {
              fillPercent = 100;
            } else {
              fillPercent = ((ote.fib618 - currentPrice) / zoneHeight) * 100;
            }
          } else {
            // For bearish OTE, price enters from below
            if (currentPrice <= ote.fib786) {
              fillPercent = 0;
            } else if (currentPrice >= ote.fib618) {
              fillPercent = 100;
            } else {
              fillPercent = ((currentPrice - ote.fib786) / zoneHeight) * 100;
            }
          }
        }

        if (fillPercent < MAX_FILL_PERCENT) {
          blocks.push({
            id: `ote-${tf}-${ote.startTime}`,
            type: ote.type,
            source: "OTE",
            timeframe: tf,
            high: ote.fib618, // OTE zone upper bound
            low: ote.fib786, // OTE zone lower bound
            entry: ote.fib675, // Entry at 0.675
            stopLoss: 0,
            takeProfit: 0,
            riskReward: 0,
            fillPercent,
          });
        }
      }
    }

    // Separate into bearish (above price) and bullish (below price)
    const bearish = blocks
      .filter((b) => b.type === "bearish")
      .sort((a, b) => b.entry - a.entry); // Higher first
    const bullish = blocks
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
  }, [currentPrice, multiTimeframeFVG, multiTimeframeOB, multiTimeframeOTE]);

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
