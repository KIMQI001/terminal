import { create } from "zustand";
import { Candle, Timeframe } from "@/types/chart";
import type { LiquidationHillData } from "@/lib/chart/primitives";
import type { KlineDisplayMode } from "@/lib/chart/klineDisplay";

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
  /** K 线显示模式:normal=全部 / short=只显示现价上方阳线 / long=只显示现价下方阴线 */
  displayMode: KlineDisplayMode;
  /** 进入显示模式那一刻的现价锚点(快照,保证可见 K 线集合稳定不闪烁) */
  displayAnchorPrice: number | null;

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
  setDisplayMode: (mode: KlineDisplayMode) => void;
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
  setCandles: (candles) =>
    set((state) => ({
      candles,
      // 过滤模式下锚点现价 = 最新一根 K 的收盘价(换标的 / 换周期后自动重新锚定)
      displayAnchorPrice:
        state.displayMode !== "normal" && candles.length > 0
          ? candles[candles.length - 1].close
          : state.displayAnchorPrice,
    })),
  updateCandle: (candle) =>
    set((state) => {
      const existingIndex = state.candles.findIndex(
        (c) => c.time === candle.time
      );

      let newCandles: Candle[];
      if (existingIndex >= 0) {
        newCandles = [...state.candles];
        newCandles[existingIndex] = candle;
      } else {
        newCandles = [...state.candles, candle];
      }

      // 过滤模式下锚点现价跟随实时 K 的最新收盘价:
      // 锚点恒等于实时 K 的收盘价 → 实时 K 永远不属于「现价以上 / 以下」→ 永远不显示
      if (state.displayMode !== "normal" && newCandles.length > 0) {
        return {
          candles: newCandles,
          displayAnchorPrice: newCandles[newCandles.length - 1].close,
        };
      }
      return { candles: newCandles };
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

  displayMode: "normal",
  displayAnchorPrice: null,
  // 切换显示模式时顺手把「当前价」锚定下来 —— 用最后一根 K 的收盘价(实时更新)
  setDisplayMode: (mode) =>
    set((state) => {
      if (mode === "normal") {
        return { displayMode: "normal" as KlineDisplayMode, displayAnchorPrice: null };
      }
      const last = state.candles[state.candles.length - 1];
      return {
        displayMode: mode,
        displayAnchorPrice: last ? last.close : null,
      };
    }),
}));
