import { create } from "zustand";
import { Position, Balance } from "@/types/order";
import { useUserStore } from "./userStore";

interface PositionState {
  positions: Position[];
  balances: Balance[];
  isLoadingBalances: boolean;
  isLoadingPositions: boolean;
  currentLeverage: number;
  isLoadingLeverage: boolean;
  balanceError: string | null;
  eventSource: EventSource | null;
  wsConnected: boolean;

  // Actions
  addPosition: (position: Omit<Position, "id" | "unrealizedPnl" | "unrealizedPnlPercent">) => void;
  updatePosition: (id: string, updates: Partial<Position>) => void;
  updatePositions: (positions: Position[]) => void;
  closePosition: (id: string) => Promise<void>;
  updateCurrentPrice: (symbol: string, price: number) => void;
  setBalances: (balances: Balance[]) => void;
  getBalance: (asset: string) => Balance | undefined;
  fetchBalances: () => Promise<void>;
  fetchPositions: () => Promise<void>;
  fetchLeverage: (symbol: string) => Promise<void>;
  setLeverage: (symbol: string, leverage: number) => Promise<boolean>;
  initUserWebSocket: () => Promise<void>;
  disconnectUserWebSocket: () => Promise<void>;
}

export const usePositionStore = create<PositionState>((set, get) => ({
  positions: [],
  balances: [],
  isLoadingBalances: false,
  isLoadingPositions: false,
  currentLeverage: 20,
  isLoadingLeverage: false,
  balanceError: null,
  eventSource: null,
  wsConnected: false,

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

  updatePositions: (positions) => {
    set({ positions });
  },

  closePosition: async (id) => {
    const token = useUserStore.getState().token;
    if (!token) {
      console.log('No token found, cannot close position');
      return;
    }

    // 找到要平仓的仓位
    const position = get().positions.find(p => p.id === id);
    if (!position) {
      console.error('Position not found:', id);
      return;
    }

    try {
      // 从 id 解析 positionSide (格式: BTCUSDC_LONG 或 BTCUSDC_SHORT)
      const positionSide = position.side === 'long' ? 'LONG' : 'SHORT';

      const response = await fetch('/api/user/positions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          symbol: position.symbol,
          positionSide,
          quantity: position.quantity,
        }),
      });

      const data = await response.json();

      if (data.success) {
        // 平仓成功，从列表中移除
        set((state) => ({
          positions: state.positions.filter((pos) => pos.id !== id),
        }));
        console.log('Position closed successfully:', data.orderId);
      } else {
        console.error('Failed to close position:', data.error);
        alert(`平仓失败: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to close position:', error);
      alert('平仓失败，请稍后重试');
    }
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

    set({ isLoadingBalances: true, balanceError: null });

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
        set({ balances, balanceError: null });
      } else {
        set({ balanceError: data.error || '获取余额失败' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : '网络错误';
      console.error('Failed to fetch balances:', error);
      set({ balanceError: msg });
    } finally {
      set({ isLoadingBalances: false });
    }
  },

  fetchPositions: async () => {
    const token = useUserStore.getState().token;
    if (!token) {
      console.log('No token found, skipping positions fetch');
      return;
    }

    const { positions } = get();
    // 只在首次加载（数据为空）时显示 loading
    if (positions.length === 0) {
      set({ isLoadingPositions: true });
    }

    try {
      const response = await fetch('/api/user/positions', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (data.success && data.positions) {
        const positions: Position[] = data.positions.map((p: {
          symbol: string;
          side: string;
          positionSide: string;
          quantity: number;
          entryPrice: number;
          markPrice: number;
          unrealizedPnl: number;
          leverage: number;
          liquidationPrice: number;
          stopLoss: number | null;
          takeProfit: number | null;
          takeProfitType: string | null;
        }) => ({
          id: `${p.symbol}_${p.positionSide}`,
          symbol: p.symbol,
          side: p.side as 'long' | 'short',
          quantity: p.quantity,
          entryPrice: p.entryPrice,
          currentPrice: p.markPrice,
          unrealizedPnl: p.unrealizedPnl,
          unrealizedPnlPercent: p.entryPrice > 0 ? (p.unrealizedPnl / (p.entryPrice * p.quantity)) * 100 : 0,
          leverage: p.leverage,
          liquidationPrice: p.liquidationPrice,
          stopLoss: p.stopLoss ?? undefined,
          takeProfit: p.takeProfit ?? undefined,
        }));
        set({ positions });
      }
    } catch (error) {
      console.error('Failed to fetch positions:', error);
    } finally {
      set({ isLoadingPositions: false });
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

  initUserWebSocket: async () => {
    const { eventSource } = get();
    if (eventSource) {
      // 已存在，先断开
      eventSource.close();
    }

    // 创建 SSE 连接订阅后端持仓更新
    const ws = new EventSource('/api/user/position-stream');

    ws.onopen = () => {
      console.log('[PositionStore] SSE 连接已打开');
      set({ wsConnected: true });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // 处理持仓更新
        if (data.type === 'position' && data.data) {
          const { positions: posUpdates } = data.data;

          // 转换持仓数据格式
          const positions: Position[] = (posUpdates || []).map((p: {
            symbol: string;
            side: 'LONG' | 'SHORT';
            quantity: number;
            entryPrice: number;
            unrealizedPnl: number;
            leverage: number;
            liquidationPrice: number;
            stopLoss?: number;
            takeProfit?: number;
          }) => ({
            id: `${p.symbol}_${p.side}`,
            symbol: p.symbol,
            side: p.side.toLowerCase() as 'long' | 'short',
            quantity: p.quantity,
            entryPrice: p.entryPrice,
            currentPrice: p.entryPrice + (p.unrealizedPnl / (p.quantity || 1)),
            unrealizedPnl: p.unrealizedPnl,
            unrealizedPnlPercent: p.entryPrice > 0 ? (p.unrealizedPnl / (p.entryPrice * p.quantity)) * 100 : 0,
            leverage: p.leverage,
            liquidationPrice: p.liquidationPrice,
            stopLoss: p.stopLoss,
            takeProfit: p.takeProfit,
          }));

          set({ positions });
        }

        // 处理连接状态
        if (data.type === 'connected') {
          console.log('[PositionStore] 后端 WebSocket 已连接');
          set({ wsConnected: true });
        }
        if (data.type === 'disconnected') {
          console.log('[PositionStore] 后端 WebSocket 已断开');
          set({ wsConnected: false });
        }
        if (data.type === 'error') {
          console.error('[PositionStore] SSE 错误:', data.message);
        }
      } catch (error) {
        console.error('[PositionStore] 解析 SSE 数据失败:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('[PositionStore] SSE 错误:', error);
      set({ wsConnected: false });
    };

    set({ eventSource: ws, wsConnected: true });
  },

  disconnectUserWebSocket: async () => {
    const { eventSource } = get();
    if (eventSource) {
      eventSource.close();
      set({ eventSource: null, wsConnected: false });
    }
  },
}));
