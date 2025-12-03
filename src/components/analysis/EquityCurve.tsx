"use client";

import { useEffect, useRef } from "react";
import { createChart, IChartApi, ISeriesApi, LineData } from "lightweight-charts";
import { EquityPoint } from "@/lib/analysis/api";

interface EquityCurveProps {
  data: EquityPoint[];
  isLoading: boolean;
}

export function EquityCurve({ data, isLoading }: EquityCurveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create chart
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#9ca3af",
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.05)" },
        horzLines: { color: "rgba(255, 255, 255, 0.05)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.1)",
      },
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.1)",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: {
          color: "rgba(255, 255, 255, 0.3)",
          labelBackgroundColor: "#374151",
        },
        horzLine: {
          color: "rgba(255, 255, 255, 0.3)",
          labelBackgroundColor: "#374151",
        },
      },
    });

    // Create line series
    const series = chart.addLineSeries({
      color: "#3b82f6",
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastValueVisible: true,
      priceLineVisible: false,
    });

    // Add zero line
    series.createPriceLine({
      price: 0,
      color: "rgba(255, 255, 255, 0.2)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "0%",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // Handle resize
    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, []);

  // Update data
  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;

    const chartData: LineData[] = data.map((point) => ({
      time: Math.floor(point.time / 1000) as import("lightweight-charts").Time,
      value: point.value,
    }));

    seriesRef.current.setData(chartData);

    // Update line color based on final value
    const finalValue = data[data.length - 1]?.value ?? 0;
    seriesRef.current.applyOptions({
      color: finalValue >= 0 ? "#22c55e" : "#ef4444",
    });

    // Fit content
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  if (isLoading) {
    return (
      <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] p-4 h-64">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">
            收益曲线
          </h3>
        </div>
        <div className="h-48 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] p-4 h-64">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">
            收益曲线
          </h3>
        </div>
        <div className="h-48 flex items-center justify-center text-[var(--text-tertiary)]">
          暂无收益数据
        </div>
      </div>
    );
  }

  const finalValue = data[data.length - 1]?.value ?? 0;

  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">
          收益曲线
        </h3>
        <span
          className={`text-sm font-medium ${
            finalValue >= 0 ? "text-green-500" : "text-red-500"
          }`}
        >
          累计: {finalValue >= 0 ? "+" : ""}
          {finalValue.toFixed(2)}%
        </span>
      </div>
      <div ref={containerRef} className="h-48" />
    </div>
  );
}
