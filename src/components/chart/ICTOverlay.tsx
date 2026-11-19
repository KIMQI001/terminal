"use client";

import { useEffect, useState, useCallback } from "react";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useChartStore } from "@/stores/chartStore";
import { IChartApi, ISeriesApi, Time } from "lightweight-charts";

interface ICTOverlayProps {
  chartRef: React.RefObject<IChartApi | null>;
  seriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

interface RenderedInducement {
  x: number;
  y: number;
  type: "bullish" | "bearish";
  triggered: boolean;
}

interface RenderedMissedPivot {
  x: number;
  y: number;
  pivotType: "high" | "low";
  color: string;
}

interface RenderedGhostLevel {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

export function ICTOverlay({ chartRef, seriesRef, containerRef }: ICTOverlayProps) {
  const [inducements, setRenderedInducements] = useState<RenderedInducement[]>([]);
  const [missedPivots, setMissedPivots] = useState<RenderedMissedPivot[]>([]);
  const [ghostLevels, setGhostLevels] = useState<RenderedGhostLevel[]>([]);
  const { enabled, inducements: inducementSignals, missedPivots: missedPivotsData, ghostLevels: ghostLevelsData } = useIndicatorStore();
  const { candles } = useChartStore();

  // Convert BOS/CHoCH signals to screen coordinates
  const updateLines = useCallback(() => {
    if (!chartRef.current || !seriesRef.current || !containerRef.current) return;

    const timeScale = chartRef.current.timeScale();
    const series = seriesRef.current;

    // ── BOS / CHoCH 结构线 + swing legs ─────────────────
    //
    // 已经移到 StructurePrimitive 绘制（见 src/lib/chart/primitives/StructurePrimitive.ts）。
    // 原因：SVG 覆盖层算出来的价格坐标会过期 —— 价格轴是 autoScale 的，
    // K 线刷新/缩放之后价格区间变了，但 SVG 只在 React effect 里更新一次，
    // 结果同一条线渲染在 y=-2976（真实位置 y=396），整条线飞到屏幕外。
    // Primitive 走 lightweight-charts 自己的绘制管线，每帧重算坐标，一定跟 K 线对齐。

    // Render Inducements
    const renderedInducements: RenderedInducement[] = [];
    if (enabled.inducement) {
      for (const ind of inducementSignals) {
        const y = series.priceToCoordinate(ind.level);
        const x = timeScale.timeToCoordinate(ind.time as Time);

        if (y !== null && x !== null) {
          renderedInducements.push({
            x,
            y,
            type: ind.type,
            triggered: ind.triggered,
          });
        }
      }
    }
    setRenderedInducements(renderedInducements);

    // Render Missed Pivots (Ghost Levels)
    const renderedMissedPivots: RenderedMissedPivot[] = [];
    const renderedGhostLevels: RenderedGhostLevel[] = [];

    if (enabled.swingPoints) {
      // Missed Pivots
      for (const mp of missedPivotsData) {
        const x = timeScale.timeToCoordinate(mp.time as Time);
        const y = series.priceToCoordinate(mp.price);

        if (x !== null && y !== null) {
          const color = mp.pivotType === "high" ? "#ef5350" : "#26a69a";
          renderedMissedPivots.push({ x, y, pivotType: mp.pivotType, color });
        }
      }

      // Ghost Levels
      for (const gl of ghostLevelsData) {
        const x1 = timeScale.timeToCoordinate(gl.startIndex as Time);
        const x2 = timeScale.timeToCoordinate(gl.endIndex as Time);
        const y1 = series.priceToCoordinate(gl.startPrice);
        const y2 = series.priceToCoordinate(gl.endPrice);

        if (x1 !== null && x2 !== null && y1 !== null && y2 !== null) {
          renderedGhostLevels.push({
            x1,
            y1,
            x2,
            y2: y1, // Ghost level is horizontal
            color: gl.color,
          });
        }
      }
    }

    setMissedPivots(renderedMissedPivots);
    setGhostLevels(renderedGhostLevels);
  }, [chartRef, seriesRef, containerRef, enabled.inducement, enabled.swingPoints, inducementSignals, missedPivotsData, ghostLevelsData]);

  // Update on data changes or scroll/zoom
  useEffect(() => {
    updateLines();

    // Subscribe to time scale changes
    const chart = chartRef.current;
    if (!chart) return;

    const timeScale = chart.timeScale();
    timeScale.subscribeVisibleLogicalRangeChange(updateLines);

    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(updateLines);
    };
  }, [updateLines, chartRef]);

  // Update when candles change
  useEffect(() => {
    updateLines();
  }, [candles, updateLines]);

  if (inducements.length === 0 && missedPivots.length === 0 && ghostLevels.length === 0) return null;

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      style={{ width: "100%", height: "100%" }}
    >
      {/* Ghost Levels */}
      {ghostLevels.map((gl, index) => (
        <line
          key={`ghost-${index}`}
          x1={gl.x1}
          y1={gl.y1}
          x2={gl.x2}
          y2={gl.y2}
          stroke={gl.color}
          strokeWidth={1}
          strokeDasharray="4,4"
          opacity={0.5}
        />
      ))}

      {/* Missed Pivots (Ghost Labels) */}
      {missedPivots.map((mp, index) => (
        <g key={`missed-${index}`}>
          {/* Ghost emoji marker */}
          <text
            x={mp.x}
            y={mp.y + 5}
            textAnchor="middle"
            fontSize="12"
            opacity={0.8}
          >
            👻
          </text>
        </g>
      ))}

      {/* Inducement markers */}
      {inducements.map((ind, index) => {
        const isBullish = ind.type === "bullish";
        // Bullish: orange (trap for longs), Bearish: cyan (trap for shorts)
        const color = isBullish ? "#f97316" : "#06b6d4";
        const opacity = ind.triggered ? 0.5 : 0.9;

        return (
          <g key={`ind-${index}`}>
            {/* Diamond marker */}
            <polygon
              points={`${ind.x},${ind.y - 6} ${ind.x + 5},${ind.y} ${ind.x},${ind.y + 6} ${ind.x - 5},${ind.y}`}
              fill={color}
              opacity={opacity}
              stroke={ind.triggered ? "#666" : color}
              strokeWidth={ind.triggered ? 1 : 0}
            />

            {/* "IDM" label */}
            <text
              x={ind.x + 8}
              y={ind.y + 3}
              fill={color}
              fontSize="9"
              fontWeight="500"
              fontFamily="monospace"
              opacity={opacity}
            >
              IDM
            </text>

            {/* Strike-through line if triggered */}
            {ind.triggered && (
              <line
                x1={ind.x - 8}
                y1={ind.y}
                x2={ind.x + 25}
                y2={ind.y}
                stroke="#666"
                strokeWidth={1}
                opacity={0.6}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
