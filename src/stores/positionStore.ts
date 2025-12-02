import { create } from "zustand";
import { Position, Balance } from "@/types/order";
import { useUserStore } from "./userStore";

interface PositionState {
  positions: Position[];
  balances: Balance[];
  isLoadingBalances: boolean;
  currentLeverage: number;
  isLoadingLeverage: boolean;

  // Actions
  addPosition: (position: Omit<Position, "id" | "unrealizedPnl" | "unrealizedPnlPercent">) => void;
  updatePosition: (id: string, updates: Partial<Position>) => void;
  closePosition: (id: string) => void;
  updateCurrentPrice: (symbol: string, price: number) => void;
  setBalances: (balances: Balance[]) => void;
  getBalance: (asset: string) => Balance | undefined;
  fetchBalances: () => Promise<void>;
  fetchLeverage: (symbol: string) => Promise<void>;
  setLeverage: (symbol: string, leverage: number) => Promise<boolean>;
}

export const usePositionStore = create<PositionState>((set, get) => ({
  positions: [],
  balances: [],
  isLoadingBalances: false,
  currentLeverage: 20,
  isLoadingLeverage: false,

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
    const token = useUserStore.getState().token;
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

  fetchLeverage: async (symbol: string) => {
    const token = useUserStore.getState().token;
    if (!token) {
      console.log('No token found, skipping leverage fetch');
      return;
    }

    set({ isLoadingLeverage: true });

    try {
      const response = await fetch(`/api/user/leverage?symbol=${symbol}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (data.success) {
        set({ currentLeverage: data.leverage });
      }
    } catch (error) {
      console.error('Failed to fetch leverage:', error);
    } finally {
      set({ isLoadingLeverage: false });
    }
  },

  setLeverage: async (symbol: string, leverage: number) => {
    const token = useUserStore.getState().token;
    if (!token) {
      console.log('No token found, cannot set leverage');
      return false;
    }

    set({ isLoadingLeverage: true });

    try {
      const response = await fetch('/api/user/leverage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ symbol, leverage }),
      });

      const data = await response.json();

      if (data.success) {
        set({ currentLeverage: data.leverage });
        return true;
      } else {
        console.error('Failed to set leverage:', data.error);
        return false;
      }
    } catch (error) {
      console.error('Failed to set leverage:', error);
      return false;
    } finally {
      set({ isLoadingLeverage: false });
    }
  },
}));
