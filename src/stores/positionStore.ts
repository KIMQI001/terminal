import { create } from "zustand";
import { Position, Balance } from "@/types/order";

interface PositionState {
  positions: Position[];
  balances: Balance[];

  // Actions
  addPosition: (position: Omit<Position, "id" | "unrealizedPnl" | "unrealizedPnlPercent">) => void;
  updatePosition: (id: string, updates: Partial<Position>) => void;
  closePosition: (id: string) => void;
  updateCurrentPrice: (symbol: string, price: number) => void;
  setBalances: (balances: Balance[]) => void;
  getBalance: (asset: string) => Balance | undefined;
}

export const usePositionStore = create<PositionState>((set, get) => ({
  positions: [
    // Demo data
    {
      id: "pos_1",
      symbol: "BTCUSDC",
      side: "long",
      quantity: 0.1,
      entryPrice: 95000,
      currentPrice: 96500,
      unrealizedPnl: 150,
      unrealizedPnlPercent: 1.58,
    },
  ],
  balances: [
    { asset: "USDT", free: 10000, locked: 0 },
    { asset: "BTC", free: 0.5, locked: 0 },
    { asset: "ETH", free: 2.0, locked: 0 },
  ],

  addPosition: (positionData) => {
    const pnl = (positionData.currentPrice - positionData.entryPrice) * positionData.quantity;
    const pnlPercent = ((positionData.currentPrice - positionData.entryPrice) / positionData.entryPrice) * 100;

    const newPosition: Position = {
      ...positionData,
      id: `pos_${Date.now()}`,
      unrealizedPnl: positionData.side === "long" ? pnl : -pnl,
      unrealizedPnlPercent: positionData.side === "long" ? pnlPercent : -pnlPercent,
    };

    set((state) => ({
      positions: [...state.positions, newPosition],
    }));
  },

  updatePosition: (id, updates) => {
    set((state) => ({
      positions: state.positions.map((pos) =>
        pos.id === id ? { ...pos, ...updates } : pos
      ),
    }));
  },

  closePosition: (id) => {
    set((state) => ({
      positions: state.positions.filter((pos) => pos.id !== id),
    }));
  },

  updateCurrentPrice: (symbol, price) => {
    set((state) => ({
      positions: state.positions.map((pos) => {
        if (pos.symbol !== symbol) return pos;

        const pnl = (price - pos.entryPrice) * pos.quantity;
        const pnlPercent = ((price - pos.entryPrice) / pos.entryPrice) * 100;

        return {
          ...pos,
          currentPrice: price,
          unrealizedPnl: pos.side === "long" ? pnl : -pnl,
          unrealizedPnlPercent: pos.side === "long" ? pnlPercent : -pnlPercent,
        };
      }),
    }));
  },

  setBalances: (balances) => set({ balances }),

  getBalance: (asset) => {
    return get().balances.find((b) => b.asset === asset);
  },
}));
