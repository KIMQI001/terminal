import { create } from "zustand";
import { Candle, Timeframe, SwingPoint } from "@/types/chart";
import type { LiquidationHillData } from "@/lib/chart/primitives";

// 日K前高前低
export interface DailyHL {
  high: number;       // 前高 (锚定K线与当日的最高)
  low: number;        // 前低 (锚定K线与当日的最低)
  pStart: number;     // 溢价区起点 (合并4D+1D后的最大P)
  dStart: number;     // 折扣区起点 (合并4D+1D后的最小D)
  anchorTime: number; // 锚定K线时间
}

// 日K价格线选中状态
export interface DailyHLLines {
  H: boolean;  // 前高
  P: boolean;  // 溢价区开始
  D: boolean;  // 折扣区开始
  L: boolean;  // 前低
}

interface ChartState {
  symbol: string;
  timeframe: Timeframe;
  chartType: "candlestick" | "line";
  candles: Candle[];
  isLoading: boolean;
  error: string | null;
  isConnected: boolean;
  liquidationData: LiquidationHillData | null;
  dailyHL: DailyHL | null;  // 日K前高前低
  dailyHLLines: DailyHLLines;  // 价格线选中状态
  lineChartPeaks: SwingPoint[];   // 折线图波峰
  lineChartValleys: SwingPoint[]; // 折线图波谷

  setSymbol: (symbol: string) => void;
  setTimeframe: (timeframe: Timeframe) => void;
  setChartType: (type: "candlestick" | "line") => void;
  setCandles: (candles: Candle[]) => void;
  updateCandle: (candle: Candle) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setConnected: (connected: boolean) => void;
  setLiquidationData: (data: LiquidationHillData | null) => void;
  setDailyHL: (data: DailyHL | null) => void;
  toggleDailyHLLine: (line: keyof DailyHLLines) => void;
  setLineChartPeaks: (peaks: SwingPoint[]) => void;
  setLineChartValleys: (valleys: SwingPoint[]) => void;
}

export const useChartStore = create<ChartState>((set) => ({
  symbol: "BTCUSDC",
  timeframe: "15m",
  chartType: "candlestick",
  candles: [],
  isLoading: false,
  error: null,
  isConnected: false,
  liquidationData: null,
  dailyHL: null,
  dailyHLLines: { H: false, P: false, D: false, L: false },
  lineChartPeaks: [],
  lineChartValleys: [],

  setSymbol: (symbol) => set({ symbol, dailyHL: null, dailyHLLines: { H: false, P: false, D: false, L: false }, lineChartPeaks: [], lineChartValleys: [] }),  // 切换symbol时清空
  setTimeframe: (timeframe) => set({ timeframe }),
  setChartType: (chartType) => set({ chartType }),
  setCandles: (candles) => set({ candles }),
  updateCandle: (candle) =>
    set((state) => {
      const existingIndex = state.candles.findIndex(
        (c) => c.time === candle.time
      );

      if (existingIndex >= 0) {
        const newCandles = [...state.candles];
        newCandles[existingIndex] = candle;
        return { candles: newCandles };
      } else {
        return { candles: [...state.candles, candle] };
      }
    }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setConnected: (isConnected) => set({ isConnected }),
  setLiquidationData: (liquidationData) => set({ liquidationData }),
  setDailyHL: (dailyHL) => set({ dailyHL }),
  toggleDailyHLLine: (line) => set((state) => ({
    dailyHLLines: {
      ...state.dailyHLLines,
      [line]: !state.dailyHLLines[line],
    },
  })),
  setLineChartPeaks: (peaks) => set({ lineChartPeaks: peaks }),
  setLineChartValleys: (valleys) => set({ lineChartValleys: valleys }),
}));
