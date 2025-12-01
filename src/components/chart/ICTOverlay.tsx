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

interface RenderedLine {
  x1: number;
  y: number;
  x2: number;
  label: string;
  type: "bos" | "choch";
  direction: "bullish" | "bearish";
}

interface RenderedInducement {
  x: number;
  y: number;
  type: "bullish" | "bearish";
  triggered: boolean;
}

interface RenderedLeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  direction: "up" | "down";
}

export function ICTOverlay({ chartRef, seriesRef, containerRef }: ICTOverlayProps) {
  const [lines, setLines] = useState<RenderedLine[]>([]);
  const [inducements, setRenderedInducements] = useState<RenderedInducement[]>([]);
  const [legs, setLegs] = useState<RenderedLeg[]>([]);
  const { enabled, bosSignals, chochSignals, inducements: inducementSignals, swingPoints } = useIndicatorStore();
  const { candles } = useChartStore();

  // Convert BOS/CHoCH signals to screen coordinates
  const updateLines = useCallback(() => {
    if (!chartRef.current || !seriesRef.current || !containerRef.current) return;

    const timeScale = chartRef.current.timeScale();
    const series = seriesRef.current;
    const renderedLines: RenderedLine[] = [];

    // Get chart width for extending lines
    const chartWidth = timeScale.width();

    // Render BOS signals
    if (enabled.bos) {
      for (const bos of bosSignals) {
        const y = series.priceToCoordinate(bos.level);
        const x1 = timeScale.timeToCoordinate(bos.swingPoint.time as Time);
        const x2 = timeScale.timeToCoordinate(bos.time as Time);

        if (y !== null && x1 !== null && x2 !== null) {
          renderedLines.push({
            x1,
            y,
            x2: Math.min(x2 + 50, chartWidth), // Extend slightly past break point
            label: "BOS",
            type: "bos",
            direction: bos.type,
          });
        }
      }
    }

    // Render CHoCH signals
    if (enabled.choch) {
      for (const choch of chochSignals) {
        const y = series.priceToCoordinate(choch.level);
        const x1 = timeScale.timeToCoordinate(choch.time as Time);

        if (y !== null && x1 !== null) {
          // CHoCH extends to chart edge
          renderedLines.push({
            x1: x1 - 30, // Start slightly before the break
            y,
            x2: chartWidth,
            label: "CHoCH",
            type: "choch",
            direction: choch.type,
          });
        }
      }
    }

    setLines(renderedLines);

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

    // Render Swing Point Legs
    const renderedLegs: RenderedLeg[] = [];
    if (enabled.swingPoints && swingPoints.length > 1) {
      for (let i = 1; i < swingPoints.length; i++) {
        const prev = swingPoints[i - 1];
        const curr = swingPoints[i];

        const x1 = timeScale.timeToCoordinate(prev.time as Time);
        const y1 = series.priceToCoordinate(prev.price);
        const x2 = timeScale.timeToCoordinate(curr.time as Time);
        const y2 = series.priceToCoordinate(curr.price);

        if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
          // Direction based on price movement
          const direction = curr.price > prev.price ? "up" : "down";
          renderedLegs.push({ x1, y1, x2, y2, direction });
        }
      }
    }
    setLegs(renderedLegs);
  }, [chartRef, seriesRef, containerRef, enabled.bos, enabled.choch, enabled.inducement, enabled.swingPoints, bosSignals, chochSignals, inducementSignals, swingPoints]);

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

  if (lines.length === 0 && inducements.length === 0 && legs.length === 0) return null;

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      style={{ width: "100%", height: "100%" }}
    >
      <defs>
        {/* BOS dashed line pattern */}
        <pattern id="bos-dash" patternUnits="userSpaceOnUse" width="8" height="1">
          <line x1="0" y1="0" x2="4" y2="0" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>

      {/* Swing Point Legs */}
      {legs.map((leg, index) => {
        const color = leg.direction === "up" ? "#22c55e" : "#ef4444";
        return (
          <line
            key={`leg-${index}`}
            x1={leg.x1}
            y1={leg.y1}
            x2={leg.x2}
            y2={leg.y2}
            stroke={color}
            strokeWidth={2}
            opacity={0.7}
          />
        );
      })}

      {lines.map((line, index) => {
        const isBullish = line.direction === "bullish";
        const isBOS = line.type === "bos";

        // Colors: BOS uses blue, CHoCH uses purple (more attention-grabbing)
        const color = isBOS
          ? (isBullish ? "#3b82f6" : "#ef4444") // Blue/Red for BOS
          : (isBullish ? "#22c55e" : "#a855f7"); // Green/Purple for CHoCH

        const strokeDasharray = isBOS ? "6,4" : "none";
        const strokeWidth = isBOS ? 1 : 2;

        return (
          <g key={`${line.type}-${index}`}>
            {/* Main line */}
            <line
              x1={line.x1}
              y1={line.y}
              x2={line.x2}
              y2={line.y}
              stroke={color}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDasharray}
              opacity={0.8}
            />

            {/* Label background */}
            <rect
              x={line.x2 - 35}
              y={line.y - 9}
              width={35}
              height={16}
              rx={3}
              fill={color}
              opacity={0.9}
            />

            {/* Label text */}
            <text
              x={line.x2 - 17}
              y={line.y + 3}
              textAnchor="middle"
              fill="white"
              fontSize="10"
              fontWeight="500"
              fontFamily="monospace"
            >
              {line.label}
            </text>

            {/* Break point marker (small circle) */}
            {isBOS && (
              <circle
                cx={line.x2 - 50}
                cy={line.y}
                r={3}
                fill={color}
                opacity={0.8}
              />
            )}
          </g>
        );
      })}

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
