import { create } from "zustand";
import { Position, Balance } from "@/types/order";

interface PositionState {
  positions: Position[];
  balances: Balance[];
  isLoadingBalances: boolean;

  // Actions
  addPosition: (position: Omit<Position, "id" | "unrealizedPnl" | "unrealizedPnlPercent">) => void;
  updatePosition: (id: string, updates: Partial<Position>) => void;
  closePosition: (id: string) => void;
  updateCurrentPrice: (symbol: string, price: number) => void;
  setBalances: (balances: Balance[]) => void;
  getBalance: (asset: string) => Balance | undefined;
  fetchBalances: () => Promise<void>;
}

export const usePositionStore = create<PositionState>((set, get) => ({
  positions: [],
  balances: [],
  isLoadingBalances: false,

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

  fetchBalances: async () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    if (!token) {
      console.log('No token found, skipping balance fetch');
      return;
    }

    set({ isLoadingBalances: true });

    try {
      const response = await fetch('/api/user/test-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ exchange: 'binance' }),
      });

      const data = await response.json();

      if (data.success && data.balance) {
        const balances: Balance[] = data.balance.map((b: { asset: string; free: string; locked: string }) => ({
          asset: b.asset,
          free: parseFloat(b.free),
          locked: parseFloat(b.locked),
        }));
        set({ balances });
      }
    } catch (error) {
      console.error('Failed to fetch balances:', error);
    } finally {
      set({ isLoadingBalances: false });
    }
  },
}));
