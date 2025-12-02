import { create } from "zustand";
import { Candle, Timeframe } from "@/types/chart";
import type { LiquidationHillData } from "@/lib/chart/primitives";

interface ChartState {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  isLoading: boolean;
  error: string | null;
  isConnected: boolean;
  liquidationData: LiquidationHillData | null;

  setSymbol: (symbol: string) => void;
  setTimeframe: (timeframe: Timeframe) => void;
  setCandles: (candles: Candle[]) => void;
  updateCandle: (candle: Candle) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setConnected: (connected: boolean) => void;
  setLiquidationData: (data: LiquidationHillData | null) => void;
}

export const useChartStore = create<ChartState>((set) => ({
  symbol: "BTCUSDC",
  timeframe: "15m",
  candles: [],
  isLoading: false,
  error: null,
  isConnected: false,
  liquidationData: null,

  setSymbol: (symbol) => set({ symbol }),
  setTimeframe: (timeframe) => set({ timeframe }),
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
}));
