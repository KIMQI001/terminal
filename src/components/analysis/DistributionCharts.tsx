"use client";

import { PerformanceStats } from "@/lib/analysis/api";

interface DistributionChartsProps {
  stats: PerformanceStats | null;
  isLoading: boolean;
}

interface PieChartData {
  label: string;
  value: number;
  color: string;
}

function PieChart({
  data,
  title,
}: {
  data: PieChartData[];
  title: string;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (total === 0) {
    return (
      <div className="text-center">
        <div className="text-xs text-[var(--text-tertiary)] mb-2">{title}</div>
        <div className="w-24 h-24 mx-auto rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center">
          <span className="text-xs text-[var(--text-tertiary)]">无数据</span>
        </div>
      </div>
    );
  }

  // Calculate pie segments
  let currentAngle = -90; // Start from top
  const segments = data.map((d) => {
    const percentage = d.value / total;
    const angle = percentage * 360;
    const startAngle = currentAngle;
    currentAngle += angle;
    return {
      ...d,
      percentage,
      startAngle,
      endAngle: currentAngle,
    };
  });

  // Create SVG path for each segment
  const createArc = (startAngle: number, endAngle: number, radius: number) => {
    const start = polarToCartesian(50, 50, radius, endAngle);
    const end = polarToCartesian(50, 50, radius, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y} L 50 50 Z`;
  };

  const polarToCartesian = (
    centerX: number,
    centerY: number,
    radius: number,
    angleInDegrees: number
  ) => {
    const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
    return {
      x: centerX + radius * Math.cos(angleInRadians),
      y: centerY + radius * Math.sin(angleInRadians),
    };
  };

  return (
    <div className="text-center">
      <div className="text-xs text-[var(--text-tertiary)] mb-2">{title}</div>
      <div className="relative w-24 h-24 mx-auto">
        <svg viewBox="0 0 100 100" className="w-full h-full">
          {segments.map((segment, index) => (
            <path
              key={index}
              d={createArc(segment.startAngle, segment.endAngle, 45)}
              fill={segment.color}
              stroke="var(--bg-secondary)"
              strokeWidth="1"
            />
          ))}
          {/* Center circle */}
          <circle cx="50" cy="50" r="25" fill="var(--bg-secondary)" />
          <text
            x="50"
            y="50"
            textAnchor="middle"
            dominantBaseline="middle"
            className="text-[8px] fill-[var(--text-tertiary)]"
          >
            {total}
          </text>
        </svg>
      </div>
      {/* Legend */}
      <div className="mt-2 space-y-1">
        {segments.map((segment, index) => (
          <div key={index} className="flex items-center justify-center gap-2 text-xs">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: segment.color }}
            />
            <span className="text-[var(--text-tertiary)]">
              {segment.label}: {segment.value} ({(segment.percentage * 100).toFixed(0)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DistributionCharts({ stats, isLoading }: DistributionChartsProps) {
  if (isLoading) {
    return (
      <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] p-4">
        <h3 className="text-sm font-medium text-[var(--text-primary)] mb-4">
          分布统计
        </h3>
        <div className="flex justify-around">
          <div className="w-24 h-24 rounded-full bg-[var(--bg-tertiary)] animate-pulse" />
          <div className="w-24 h-24 rounded-full bg-[var(--bg-tertiary)] animate-pulse" />
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] p-4 text-center text-[var(--text-tertiary)]">
        无法加载分布数据
      </div>
    );
  }

  // Direction distribution
  const directionData: PieChartData[] = [
    {
      label: "做多",
      value: stats.byDirection?.long?.signals || 0,
      color: "#22c55e",
    },
    {
      label: "做空",
      value: stats.byDirection?.short?.signals || 0,
      color: "#ef4444",
    },
  ];

  // Timeframe distribution
  const timeframeColors: Record<string, string> = {
    "5m": "#3b82f6",
    "15m": "#8b5cf6",
    "1h": "#f59e0b",
    "4h": "#10b981",
    "1d": "#ec4899",
  };

  const timeframeData: PieChartData[] = Object.entries(stats.byTimeframe || {}).map(
    ([tf, data]) => ({
      label: tf,
      value: data.signals,
      color: timeframeColors[tf] || "#6b7280",
    })
  );

  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)] p-4">
      <h3 className="text-sm font-medium text-[var(--text-primary)] mb-4">
        分布统计
      </h3>
      <div className="flex justify-around">
        <PieChart data={directionData} title="方向分布" />
        <PieChart data={timeframeData} title="周期分布" />
      </div>
    </div>
  );
}
