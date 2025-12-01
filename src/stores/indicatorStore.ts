import { create } from "zustand";
import { IndicatorState, OrderBlock, FVG, BOS, CHoCH, LiquidityZone } from "@/types/indicator";

interface IndicatorStoreState {
  enabled: IndicatorState;
  orderBlocks: OrderBlock[];
  fvgs: FVG[];
  bosSignals: BOS[];
  chochSignals: CHoCH[];
  liquidityZones: LiquidityZone[];

  toggleIndicator: (key: keyof IndicatorState) => void;
  setOrderBlocks: (blocks: OrderBlock[]) => void;
  setFVGs: (fvgs: FVG[]) => void;
  setBOSSignals: (signals: BOS[]) => void;
  setCHoCHSignals: (signals: CHoCH[]) => void;
  setLiquidityZones: (zones: LiquidityZone[]) => void;
  clearAll: () => void;
}

export const useIndicatorStore = create<IndicatorStoreState>((set) => ({
  enabled: {
    orderBlocks: true,
    fvg: true,
    bos: false,
    choch: false,
    liquidityZones: false,
    killzones: false,
  },
  orderBlocks: [],
  fvgs: [],
  bosSignals: [],
  chochSignals: [],
  liquidityZones: [],

  toggleIndicator: (key) =>
    set((state) => ({
      enabled: {
        ...state.enabled,
        [key]: !state.enabled[key],
      },
    })),

  setOrderBlocks: (blocks) => set({ orderBlocks: blocks }),
  setFVGs: (fvgs) => set({ fvgs }),
  setBOSSignals: (signals) => set({ bosSignals: signals }),
  setCHoCHSignals: (signals) => set({ chochSignals: signals }),
  setLiquidityZones: (zones) => set({ liquidityZones: zones }),
  clearAll: () =>
    set({
      orderBlocks: [],
      fvgs: [],
      bosSignals: [],
      chochSignals: [],
      liquidityZones: [],
    }),
}));
