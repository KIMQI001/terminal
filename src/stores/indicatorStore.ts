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
