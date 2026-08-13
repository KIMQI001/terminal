import { create } from "zustand";
import { IndicatorState, OrderBlock, FVG, BOS, CHoCH, LiquidityZone } from "@/types/indicator";
import { SwingPoint, Timeframe } from "@/types/chart";

// localStorage 持久化 key
const INDICATOR_ENABLED_KEY = 'terminal.indicator.enabled';

// 页面加载时读取 localStorage 覆盖默认 enabled
const loadEnabled = (): IndicatorState => {
  if (typeof window === 'undefined') return {} as IndicatorState;
  try {
    const raw = localStorage.getItem(INDICATOR_ENABLED_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // 忽略解析错误
  }
  return {} as IndicatorState;
};
import { OTEZone } from "@/lib/chart/indicators/ote";
import { BreakerBlock } from "@/lib/chart/indicators/breakerBlocks";
import { Inducement } from "@/lib/chart/indicators/inducement";
import { MissedPivot, GhostLevel } from "@/lib/chart/indicators/swingPoints";
import { EngulfingPinbar } from "@/lib/chart/indicators/engulfingPinbar";
import { EquilibriumLevel, ZoneSide } from "@/lib/chart/indicators/equilibrium";
import { InitialBalanceData } from "@/lib/chart/indicators/initialBalance";
import { AsiaBiasData } from "@/lib/chart/indicators/asiaBias";
import { EuropeBiasData } from "@/lib/chart/indicators/europeBias";

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

// 多周期 Equilibrium（仅 HTF 面板用，不画在图上）
export interface MultiTimeframeEquilibriumEntry {
  equilibrium: number;
  side: ZoneSide;
  swingHigh: number;
  swingLow: number;
}

type MultiTimeframeEquilibrium = {
  '5m': MultiTimeframeEquilibriumEntry | null;
  '15m': MultiTimeframeEquilibriumEntry | null;
  '1h': MultiTimeframeEquilibriumEntry | null;
  '4h': MultiTimeframeEquilibriumEntry | null;
  '1d': MultiTimeframeEquilibriumEntry | null;
  '1w': MultiTimeframeEquilibriumEntry | null;
};

interface IndicatorStoreState {
  enabled: IndicatorState;
  swingPoints: SwingPoint[];
  missedPivots: MissedPivot[];
  ghostLevels: GhostLevel[];
  engulfingPinbars: EngulfingPinbar[];
  orderBlocks: OrderBlock[];
  fvgs: FVG[];
  bosSignals: BOS[];
  chochSignals: CHoCH[];
  liquidityZones: LiquidityZone[];
  oteZones: OTEZone[];
  breakerBlocks: BreakerBlock[];
  inducements: Inducement[];
  equilibriumLevels: EquilibriumLevel[];
  multiTimeframeOTE: MultiTimeframeOTE;
  multiTimeframeFVG: MultiTimeframeFVG;
  multiTimeframeOB: MultiTimeframeOB;
  multiTimeframeTrend: MultiTimeframeTrend;
  multiTimeframeEquilibrium: MultiTimeframeEquilibrium;
  initialBalance: InitialBalanceData | null;
  asiaBias: AsiaBiasData | null;
  europeBias: EuropeBiasData | null;

  toggleIndicator: (key: keyof IndicatorState) => void;
  setSwingPoints: (points: SwingPoint[]) => void;
  setMissedPivots: (pivots: MissedPivot[]) => void;
  setGhostLevels: (levels: GhostLevel[]) => void;
  setEngulfingPinbars: (pinbars: EngulfingPinbar[]) => void;
  setOrderBlocks: (blocks: OrderBlock[]) => void;
  setFVGs: (fvgs: FVG[]) => void;
  setBOSSignals: (signals: BOS[]) => void;
  setCHoCHSignals: (signals: CHoCH[]) => void;
  setLiquidityZones: (zones: LiquidityZone[]) => void;
  setOTEZones: (zones: OTEZone[]) => void;
  setBreakerBlocks: (blocks: BreakerBlock[]) => void;
  setInducements: (inducements: Inducement[]) => void;
  setEquilibriumLevels: (levels: EquilibriumLevel[]) => void;
  setMultiTimeframeOTE: (timeframe: Timeframe, ote: OTEZone | null) => void;
  setMultiTimeframeFVG: (timeframe: Timeframe, fvg: FVG | null) => void;
  setMultiTimeframeOB: (timeframe: Timeframe, ob: OrderBlock | null) => void;
  setMultiTimeframeTrend: (timeframe: Timeframe, trend: TrendType) => void;
  setMultiTimeframeEquilibrium: (
    timeframe: Timeframe,
    entry: MultiTimeframeEquilibriumEntry | null
  ) => void;
  setInitialBalance: (data: InitialBalanceData | null) => void;
  setAsiaBias: (data: AsiaBiasData | null) => void;
  setEuropeBias: (data: EuropeBiasData | null) => void;
  clearAll: () => void;
}

export const useIndicatorStore = create<IndicatorStoreState>((set) => {
  // 从 localStorage 读取已保存的开关状态，跟默认值合并（保存的优先）
  const persistedEnabled = loadEnabled();
  const defaultEnabled: IndicatorState = {
    swingPoints: true,
    orderBlocks: false,
    fvg: false,
    bos: false,
    choch: false,
    liquidityZones: false,
    killzones: true,
    ote: true,
    breakerBlocks: false,
    inducement: false,
    equilibrium: true,
    rejections: false,
  };
  return {
    enabled: { ...defaultEnabled, ...persistedEnabled },

  swingPoints: [],
  missedPivots: [],
  ghostLevels: [],
  engulfingPinbars: [],
  orderBlocks: [],
  fvgs: [],
  bosSignals: [],
  chochSignals: [],
  liquidityZones: [],
  oteZones: [],
  breakerBlocks: [],
  inducements: [],
  equilibriumLevels: [],
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
  multiTimeframeEquilibrium: {
    '5m': null,
    '15m': null,
    '1h': null,
    '4h': null,
    '1d': null,
    '1w': null,
  },
  initialBalance: null,
  asiaBias: null,
  europeBias: null,

  toggleIndicator: (key) =>
    set((state) => ({
      enabled: {
        ...state.enabled,
        [key]: !state.enabled[key],
      },
    })),

  setSwingPoints: (points) => set({ swingPoints: points }),
  setMissedPivots: (pivots) => set({ missedPivots: pivots }),
  setGhostLevels: (levels) => set({ ghostLevels: levels }),
  setEngulfingPinbars: (pinbars) => set({ engulfingPinbars: pinbars }),
  setOrderBlocks: (blocks) => set({ orderBlocks: blocks }),
  setFVGs: (fvgs) => set({ fvgs }),
  setBOSSignals: (signals) => set({ bosSignals: signals }),
  setCHoCHSignals: (signals) => set({ chochSignals: signals }),
  setLiquidityZones: (zones) => set({ liquidityZones: zones }),
  setOTEZones: (zones) => set({ oteZones: zones }),
  setBreakerBlocks: (blocks) => set({ breakerBlocks: blocks }),
  setInducements: (inducements) => set({ inducements }),
  setEquilibriumLevels: (levels) => set({ equilibriumLevels: levels }),
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
  setMultiTimeframeEquilibrium: (timeframe, entry) =>
    set((state) => ({
      multiTimeframeEquilibrium: {
        ...state.multiTimeframeEquilibrium,
        [timeframe]: entry,
      },
    })),
  setInitialBalance: (data) => set({ initialBalance: data }),
  setAsiaBias: (data) => set({ asiaBias: data }),
  setEuropeBias: (data) => set({ europeBias: data }),
  clearAll: () =>
    set({
      swingPoints: [],
      missedPivots: [],
      ghostLevels: [],
      engulfingPinbars: [],
      orderBlocks: [],
      fvgs: [],
      bosSignals: [],
      chochSignals: [],
      liquidityZones: [],
      oteZones: [],
      breakerBlocks: [],
      inducements: [],
      equilibriumLevels: [],
    }),
  };
});

// 监听 enabled 变化，持久化到 localStorage
if (typeof window !== 'undefined') {
  useIndicatorStore.subscribe((state) => {
    try {
      localStorage.setItem(INDICATOR_ENABLED_KEY, JSON.stringify(state.enabled));
    } catch {
      // 忽略 localStorage 写入失败（隐私模式 / 容量超限）
    }
  });
}
