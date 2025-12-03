import { create } from "zustand";
import { IndicatorState, OrderBlock, FVG, BOS, CHoCH, LiquidityZone } from "@/types/indicator";
import { SwingPoint, Timeframe } from "@/types/chart";
import { OTEZone } from "@/lib/chart/indicators/ote";
import { BreakerBlock } from "@/lib/chart/indicators/breakerBlocks";
import { Inducement } from "@/lib/chart/indicators/inducement";

// 多周期 OTE 类型
interface MultiTimeframeOTE {
  '5m': OTEZone | null;
  '15m': OTEZone | null;
  '1h': OTEZone | null;
  '4h': OTEZone | null;
  '1d': OTEZone | null;
  '1w': OTEZone | null;
}

// 多周期 FVG 类型
interface MultiTimeframeFVG {
  '5m': FVG | null;
  '15m': FVG | null;
  '1h': FVG | null;
  '4h': FVG | null;
  '1d': FVG | null;
  '1w': FVG | null;
}

// 多周期 OB 类型
interface MultiTimeframeOB {
  '5m': OrderBlock | null;
  '15m': OrderBlock | null;
  '1h': OrderBlock | null;
  '4h': OrderBlock | null;
  '1d': OrderBlock | null;
  '1w': OrderBlock | null;
}

// 趋势类型
export type TrendType = 'bullish' | 'bearish' | 'neutral';

// 多周期趋势类型
interface MultiTimeframeTrend {
  '5m': TrendType;
  '15m': TrendType;
  '1h': TrendType;
  '4h': TrendType;
  '1d': TrendType;
}

interface IndicatorStoreState {
  enabled: IndicatorState;
  swingPoints: SwingPoint[];
  orderBlocks: OrderBlock[];
  fvgs: FVG[];
  bosSignals: BOS[];
  chochSignals: CHoCH[];
  liquidityZones: LiquidityZone[];
  oteZones: OTEZone[];
  breakerBlocks: BreakerBlock[];
  inducements: Inducement[];
  multiTimeframeOTE: MultiTimeframeOTE;
  multiTimeframeFVG: MultiTimeframeFVG;
  multiTimeframeOB: MultiTimeframeOB;
  multiTimeframeTrend: MultiTimeframeTrend;

  toggleIndicator: (key: keyof IndicatorState) => void;
  setSwingPoints: (points: SwingPoint[]) => void;
  setOrderBlocks: (blocks: OrderBlock[]) => void;
  setFVGs: (fvgs: FVG[]) => void;
  setBOSSignals: (signals: BOS[]) => void;
  setCHoCHSignals: (signals: CHoCH[]) => void;
  setLiquidityZones: (zones: LiquidityZone[]) => void;
  setOTEZones: (zones: OTEZone[]) => void;
  setBreakerBlocks: (blocks: BreakerBlock[]) => void;
  setInducements: (inducements: Inducement[]) => void;
  setMultiTimeframeOTE: (timeframe: Timeframe, ote: OTEZone | null) => void;
  setMultiTimeframeFVG: (timeframe: Timeframe, fvg: FVG | null) => void;
  setMultiTimeframeOB: (timeframe: Timeframe, ob: OrderBlock | null) => void;
  setMultiTimeframeTrend: (timeframe: Timeframe, trend: TrendType) => void;
  clearAll: () => void;
}

export const useIndicatorStore = create<IndicatorStoreState>((set) => ({
  enabled: {
    swingPoints: false,
    orderBlocks: false,
    fvg: false,
    bos: false,
    choch: false,
    liquidityZones: false,
    killzones: false,
    ote: true,
    breakerBlocks: false,
    inducement: false,
  },
  swingPoints: [],
  orderBlocks: [],
  fvgs: [],
  bosSignals: [],
  chochSignals: [],
  liquidityZones: [],
  oteZones: [],
  breakerBlocks: [],
  inducements: [],
  multiTimeframeOTE: {
    '5m': null,
    '15m': null,
    '1h': null,
    '4h': null,
    '1d': null,
    '1w': null,
  },
  multiTimeframeFVG: {
    '5m': null,
    '15m': null,
    '1h': null,
    '4h': null,
    '1d': null,
    '1w': null,
  },
  multiTimeframeOB: {
    '5m': null,
    '15m': null,
    '1h': null,
    '4h': null,
    '1d': null,
    '1w': null,
  },
  multiTimeframeTrend: {
    '5m': 'neutral',
    '15m': 'neutral',
    '1h': 'neutral',
    '4h': 'neutral',
    '1d': 'neutral',
  },

  toggleIndicator: (key) =>
    set((state) => ({
      enabled: {
        ...state.enabled,
        [key]: !state.enabled[key],
      },
    })),

  setSwingPoints: (points) => set({ swingPoints: points }),
  setOrderBlocks: (blocks) => set({ orderBlocks: blocks }),
  setFVGs: (fvgs) => set({ fvgs }),
  setBOSSignals: (signals) => set({ bosSignals: signals }),
  setCHoCHSignals: (signals) => set({ chochSignals: signals }),
  setLiquidityZones: (zones) => set({ liquidityZones: zones }),
  setOTEZones: (zones) => set({ oteZones: zones }),
  setBreakerBlocks: (blocks) => set({ breakerBlocks: blocks }),
  setInducements: (inducements) => set({ inducements }),
  setMultiTimeframeOTE: (timeframe, ote) =>
    set((state) => ({
      multiTimeframeOTE: {
        ...state.multiTimeframeOTE,
        [timeframe]: ote,
      },
    })),
  setMultiTimeframeFVG: (timeframe, fvg) =>
    set((state) => ({
      multiTimeframeFVG: {
        ...state.multiTimeframeFVG,
        [timeframe]: fvg,
      },
    })),
  setMultiTimeframeOB: (timeframe, ob) =>
    set((state) => ({
      multiTimeframeOB: {
        ...state.multiTimeframeOB,
        [timeframe]: ob,
      },
    })),
  setMultiTimeframeTrend: (timeframe, trend) =>
    set((state) => ({
      multiTimeframeTrend: {
        ...state.multiTimeframeTrend,
        [timeframe]: trend,
      },
    })),
  clearAll: () =>
    set({
      swingPoints: [],
      orderBlocks: [],
      fvgs: [],
      bosSignals: [],
      chochSignals: [],
      liquidityZones: [],
      oteZones: [],
      breakerBlocks: [],
      inducements: [],
    }),
}));
