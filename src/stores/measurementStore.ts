import { create } from "zustand";

interface Point {
  price: number | null;  // 可能为 null（边缘区域）
  time: number | null;   // 可能为 null（边缘区域）
  x: number;             // 屏幕坐标，始终有效
  y: number;             // 屏幕坐标，始终有效
}

interface MeasurementResult {
  priceDiff: number | null;     // null 表示无法计算
  pricePercent: number | null;  // null 表示无法计算
  timeDiff: number | null;      // null 表示无法计算
  barCount: number | null;      // null 表示无法计算
}

interface Measurement {
  id: string;
  startPoint: Point;
  endPoint: Point;
  result: MeasurementResult;
}

// 简化状态：idle -> drawing -> completed -> idle
type MeasurementPhase = "idle" | "drawing" | "completed";

interface MeasurementState {
  phase: MeasurementPhase;
  isToolActive: boolean; // 工具栏按钮是否激活
  currentMeasurement: Measurement | null;

  // Actions
  setToolActive: (active: boolean) => void;
  toggleToolActive: () => void;
  startDrawing: (point: Point, timeframe: string) => void;
  updateDrawing: (point: Point, timeframe: string) => void;
  completeDrawing: () => void;
  clearMeasurement: () => void;
}

// 根据时间差（秒）和timeframe计算K线数量
// 注意：lightweight-charts 的 time 是 Unix 时间戳（秒），不是毫秒
function calculateBarCount(timeDiffSeconds: number, timeframe: string): number {
  const timeframeSeconds: Record<string, number> = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "1h": 60 * 60,
    "4h": 4 * 60 * 60,
    "1d": 24 * 60 * 60,
    "1w": 7 * 24 * 60 * 60,
  };

  const interval = timeframeSeconds[timeframe] || timeframeSeconds["1h"];
  return Math.abs(Math.round(timeDiffSeconds / interval));
}

function calculateResult(
  startPoint: Point,
  endPoint: Point,
  timeframe: string
): MeasurementResult {
  // 如果价格有效，计算价格相关数据
  let priceDiff: number | null = null;
  let pricePercent: number | null = null;

  if (startPoint.price !== null && endPoint.price !== null) {
    priceDiff = endPoint.price - startPoint.price;
    pricePercent = startPoint.price !== 0 ? (priceDiff / startPoint.price) * 100 : 0;
  }

  // 如果时间有效，计算时间相关数据
  let timeDiff: number | null = null;
  let barCount: number | null = null;

  if (startPoint.time !== null && endPoint.time !== null) {
    const timeDiffSeconds = endPoint.time - startPoint.time;
    timeDiff = timeDiffSeconds * 1000; // 转换为毫秒用于显示
    barCount = calculateBarCount(timeDiffSeconds, timeframe);
  }

  return { priceDiff, pricePercent, timeDiff, barCount };
}

export const useMeasurementStore = create<MeasurementState>((set, get) => ({
  phase: "idle",
  isToolActive: false,
  currentMeasurement: null,

  setToolActive: (active: boolean) => {
    set({
      isToolActive: active,
      // 如果关闭工具，同时清除测量
      ...(active ? {} : { phase: "idle", currentMeasurement: null }),
    });
  },

  toggleToolActive: () => {
    const { isToolActive } = get();
    get().setToolActive(!isToolActive);
  },

  startDrawing: (point: Point, timeframe: string) => {
    set({
      phase: "drawing",
      currentMeasurement: {
        id: `measurement_${Date.now()}`,
        startPoint: point,
        endPoint: point,
        result: { priceDiff: 0, pricePercent: 0, timeDiff: 0, barCount: 0 },
      },
    });
  },

  updateDrawing: (point: Point, timeframe: string) => {
    const { phase, currentMeasurement } = get();
    if (phase !== "drawing" || !currentMeasurement) return;

    const result = calculateResult(currentMeasurement.startPoint, point, timeframe);
    set({
      currentMeasurement: {
        ...currentMeasurement,
        endPoint: point,
        result,
      },
    });
  },

  completeDrawing: () => {
    const { phase, currentMeasurement } = get();
    if (phase !== "drawing" || !currentMeasurement) return;

    set({ phase: "completed" });
  },

  clearMeasurement: () => {
    const { isToolActive } = get();
    set({
      phase: "idle",
      currentMeasurement: null,
      // 如果是工具栏模式，测量完成后关闭工具
      isToolActive: false,
    });
  },
}));
