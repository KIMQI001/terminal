import { create } from "zustand";
import { Candle, Timeframe } from "@/types/chart";
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

// 日K锚点 OHLC（用于在图上画 4 条线）
export interface DailyKAnchor {
  open: number;
  high: number;
  low: number;
  close: number;
  time: number;
  visible: { O: boolean; H: boolean; L: boolean; C: boolean };
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
  dailyKAnchors: { '1D': DailyKAnchor | null; '4D': DailyKAnchor | null };  // 日K/4D 锚点 OHLC
  dailyKLineEnabled: boolean;  // 是否在图上画日K锚点 OHLC 线

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
  setDailyKAnchor: (tf: '1D' | '4D', anchor: DailyKAnchor | null) => void;
  toggleDailyKLine: (tf: '1D' | '4D', line: 'O' | 'H' | 'L' | 'C') => void;
  setDailyKLineEnabled: (enabled: boolean) => void;
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

  setSymbol: (symbol) => set({ symbol, dailyHL: null, dailyHLLines: { H: false, P: false, D: false, L: false } }),  // 切换symbol时清空
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
  dailyKAnchors: { '1D': null, '4D': null },
  setDailyKAnchor: (tf, anchor) => set((state) => ({
    dailyKAnchors: { ...state.dailyKAnchors, [tf]: anchor },
  })),
  toggleDailyKLine: (tf, line) => set((state) => {
    const current = state.dailyKAnchors[tf];
    if (!current) return state;
    return {
      dailyKAnchors: {
        ...state.dailyKAnchors,
        [tf]: { ...current, visible: { ...current.visible, [line]: !current.visible[line] } },
      },
    };
  }),
  dailyKLineEnabled: false,
  setDailyKLineEnabled: (enabled) => set({ dailyKLineEnabled: enabled }),
}));
