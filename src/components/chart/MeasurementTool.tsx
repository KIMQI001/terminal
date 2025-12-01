"use client";

import { useMeasurementStore } from "@/stores/measurementStore";

// 格式化时间差 - TV风格
function formatTimeDiff(ms: number): string {
  const absMs = Math.abs(ms);
  const totalMinutes = Math.floor(absMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);

  return parts.length > 0 ? parts.join(" ") : "0m";
}

// 格式化价格 - 带逗号分隔
function formatPrice(price: number): string {
  const absPrice = Math.abs(price);
  if (absPrice >= 1000) {
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
  if (absPrice >= 1) {
    return price.toFixed(2);
  }
  if (absPrice >= 0.01) {
    return price.toFixed(4);
  }
  return price.toFixed(6);
}

// 格式化斐波那契价格（更简洁）
function formatFibPrice(price: number): string {
  const absPrice = Math.abs(price);
  if (absPrice >= 1000) {
    return price.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (absPrice >= 1) {
    return price.toFixed(2);
  }
  return price.toFixed(4);
}

// 斐波那契回撤级别（颜色会根据涨跌动态调整）
const FIB_LEVELS = [
  { ratio: 0.5, label: "0.5" },
  { ratio: 0.618, label: "0.618" },
  { ratio: 0.68, label: "0.68" },
  { ratio: 0.786, label: "0.786" },
];

export function MeasurementTool() {
  const { currentMeasurement, phase } = useMeasurementStore();

  if (phase === "idle" || !currentMeasurement) return null;

  const { startPoint, endPoint, result } = currentMeasurement;

  // 判断数据有效性
  const hasPriceData = result.priceDiff !== null && result.pricePercent !== null;
  const hasTimeData = result.timeDiff !== null && result.barCount !== null;
  const isPositive = hasPriceData ? result.priceDiff! >= 0 : true;

  // 颜色 - TradingView 风格
  const lineColor = isPositive ? "#26a69a" : "#ef5350"; // 绿/红
  const bgColor = "rgba(42, 46, 57, 0.9)"; // TV 深色背景

  // 标签位置：终点右侧偏移
  const labelOffsetX = 12;
  const labelX = endPoint.x + labelOffsetX;
  const labelY = endPoint.y;

  // 构建显示文本
  const priceText = hasPriceData
    ? `${isPositive ? "+" : ""}${formatPrice(result.priceDiff!)} (${isPositive ? "+" : ""}${result.pricePercent!.toFixed(2)}%)`
    : "--";

  const timeText = hasTimeData
    ? `${result.barCount} bars, ${formatTimeDiff(result.timeDiff!)}`
    : "--";

  // 计算标签宽度（根据文本长度动态调整）
  const labelWidth = Math.max(priceText.length * 7.5, timeText.length * 6.5, 120);
  const labelHeight = 44;
  const labelPadding = 10;

  // 斐波那契线颜色：跟随主线颜色，但透明度不同
  const fibColors = isPositive
    ? ["rgba(38, 166, 154, 0.5)", "rgba(38, 166, 154, 0.6)", "rgba(38, 166, 154, 0.7)", "rgba(38, 166, 154, 0.9)"]  // 绿色渐变
    : ["rgba(239, 83, 80, 0.5)", "rgba(239, 83, 80, 0.6)", "rgba(239, 83, 80, 0.7)", "rgba(239, 83, 80, 0.9)"];    // 红色渐变

  // 计算斐波那契回撤线
  // 回撤是从终点往起点方向回撤，即：终点 + (起点 - 终点) * ratio
  const fibLines = FIB_LEVELS.map((level, index) => {
    // 从终点回撤到起点方向
    const fibY = endPoint.y + (startPoint.y - endPoint.y) * level.ratio;
    // 计算对应的价格（如果有价格数据）
    let fibPrice: number | null = null;
    if (startPoint.price !== null && endPoint.price !== null) {
      fibPrice = endPoint.price + (startPoint.price - endPoint.price) * level.ratio;
    }
    return {
      ...level,
      y: fibY,
      price: fibPrice,
      color: fibColors[index],
    };
  });

  // 计算水平线的 x 范围（从起点到终点，稍微延伸）
  const minX = Math.min(startPoint.x, endPoint.x);
  const maxX = Math.max(startPoint.x, endPoint.x);
  const lineExtend = 20; // 线条两端延伸

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-20"
      style={{ width: "100%", height: "100%" }}
    >
      {/* 斐波那契回撤线 */}
      {fibLines.map((fib) => (
        <g key={fib.label}>
          {/* 水平虚线 */}
          <line
            x1={minX - lineExtend}
            y1={fib.y}
            x2={maxX + lineExtend}
            y2={fib.y}
            stroke={fib.color}
            strokeWidth={1}
            strokeDasharray="4 3"
            strokeOpacity={0.8}
          />
          {/* 标签背景 + 文字（只显示价格） */}
          {fib.price !== null && (
            <g transform={`translate(${maxX + lineExtend + 4}, ${fib.y})`}>
              <rect
                x={0}
                y={-10}
                width={56}
                height={20}
                rx={3}
                fill={fib.color}
                fillOpacity={0.9}
              />
              <text
                x={4}
                y={4}
                fill="white"
                fontSize={10}
                fontWeight="500"
                fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
              >
                {formatFibPrice(fib.price)}
              </text>
            </g>
          )}
        </g>
      ))}

      {/* 主测量线 */}
      <line
        x1={startPoint.x}
        y1={startPoint.y}
        x2={endPoint.x}
        y2={endPoint.y}
        stroke={lineColor}
        strokeWidth={1.5}
      />

      {/* 起点圆点 */}
      <circle
        cx={startPoint.x}
        cy={startPoint.y}
        r={4}
        fill={lineColor}
      />

      {/* 终点圆点 */}
      <circle
        cx={endPoint.x}
        cy={endPoint.y}
        r={4}
        fill={lineColor}
      />

      {/* 标签背景 + 内容 */}
      <g transform={`translate(${labelX}, ${labelY})`}>
        {/* 连接线到标签 */}
        <line
          x1={-labelOffsetX + 4}
          y1={0}
          x2={0}
          y2={0}
          stroke={lineColor}
          strokeWidth={1}
        />

        {/* 背景矩形 */}
        <rect
          x={0}
          y={-labelHeight / 2}
          width={labelWidth}
          height={labelHeight}
          rx={4}
          fill={bgColor}
        />

        {/* 第一行：价格变化 + 百分比 */}
        <text
          x={labelPadding}
          y={-6}
          fill={isPositive ? "#26a69a" : "#ef5350"}
          fontSize={13}
          fontWeight="500"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif"
        >
          {priceText}
        </text>

        {/* 第二行：K线数 + 时间 */}
        <text
          x={labelPadding}
          y={14}
          fill="rgba(255, 255, 255, 0.7)"
          fontSize={11}
          fontFamily="-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif"
        >
          {timeText}
        </text>
      </g>
    </svg>
  );
}
