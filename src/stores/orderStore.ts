import { create } from "zustand";
import { Order, OrderFormData, OrderStatus, OrderSide } from "@/types/order";
import { useUserStore } from "./userStore";

// OTE预填充数据
export interface OTEPrefillData {
  side: OrderSide;
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

// 图表上显示的交易线条
export interface TradingLine {
  price: number;
  type: "entry" | "stopLoss" | "takeProfit";
  side: OrderSide;
}

// 真实挂单数据
export interface RealOrder {
  id: string;
  symbol: string;
  side: string;
  positionSide: string;
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
  status: string;
  time: number;
}

interface OrderState {
  orders: Order[];
  realOrders: RealOrder[];
  isLoadingOrders: boolean;
  isModalOpen: boolean;
  prefillData: OTEPrefillData | null;
  tradingLines: TradingLine[];
  isPlacingOrder: boolean;
  orderError: string | null;

  // Actions
  openModal: () => void;
  closeModal: () => void;
  togglePanel: () => void;
  setPrefillData: (data: OTEPrefillData | null) => void;
  setTradingLines: (lines: TradingLine[]) => void;
  clearTradingLines: () => void;
  addOrder: (data: OrderFormData, symbol: string) => Order;
  placeOrder: (data: OrderFormData, symbol: string) => Promise<{ success: boolean; error?: string }>;
  updateOrderStatus: (id: string, status: OrderStatus, filledQuantity?: number) => void;
  cancelOrder: (id: string, symbol: string) => Promise<boolean>;
  cancelAllOrders: (symbol: string) => Promise<boolean>;
  fetchOpenOrders: (symbol?: string) => Promise<void>;
  getOpenOrders: () => Order[];
  getOrderHistory: () => Order[];
}

export const useOrderStore = create<OrderState>((set, get) => ({
  orders: [],
  realOrders: [],
  isLoadingOrders: false,
  isModalOpen: false,
  prefillData: null,
  tradingLines: [],
  isPlacingOrder: false,
  orderError: null,

  openModal: () => set({ isModalOpen: true }),
  closeModal: () => set({ isModalOpen: false, prefillData: null, tradingLines: [] }),
  togglePanel: () => set((state) => ({ isModalOpen: !state.isModalOpen })),
  setPrefillData: (data) => set({ prefillData: data }),
  setTradingLines: (lines) => set({ tradingLines: lines }),
  clearTradingLines: () => set({ tradingLines: [] }),

  addOrder: (data, symbol) => {
    const newOrder: Order = {
      id: `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      symbol,
      type: data.type,
      side: data.side,
      price: data.price,
      stopPrice: data.stopPrice,
      quantity: data.quantity,
      filledQuantity: 0,
      status: data.type === "market" ? "filled" : "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    set((state) => ({
      orders: [newOrder, ...state.orders],
    }));

    return newOrder;
  },

  placeOrder: async (data, symbol) => {
    const token = useUserStore.getState().token;
    if (!token) {
      return { success: false, error: '未登录' };
    }

    set({ isPlacingOrder: true, orderError: null });

    try {
      const response = await fetch('/api/user/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          symbol,
          side: data.side === 'buy' ? 'BUY' : 'SELL',
          type: data.type === 'market' ? 'MARKET' : 'LIMIT',
          quantity: data.quantity,
          price: data.price,
          stopLoss: data.stopPrice,  // 止损价
          takeProfit: data.takeProfit,  // 止盈价
        }),
      });

      const result = await response.json();

      if (result.success) {
        // 添加到本地订单列表
        const newOrder: Order = {
          id: result.order.orderId.toString(),
          symbol: result.order.symbol,
          type: data.type,
          side: data.side,
          price: parseFloat(result.order.price) || data.price,
          stopPrice: data.stopPrice,
          quantity: parseFloat(result.order.quantity),
          filledQuantity: 0,
          status: result.order.status === 'FILLED' ? 'filled' : 'pending',
          createdAt: result.order.time || Date.now(),
          updatedAt: Date.now(),
        };

        set((state) => ({
          orders: [newOrder, ...state.orders],
          isPlacingOrder: false,
        }));

        return { success: true };
      } else {
        set({ isPlacingOrder: false, orderError: result.error });
        return { success: false, error: result.error };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '下单失败';
      set({ isPlacingOrder: false, orderError: errorMsg });
      return { success: false, error: errorMsg };
    }
  },

  updateOrderStatus: (id, status, filledQuantity) => {
    set((state) => ({
      orders: state.orders.map((order) =>
        order.id === id
          ? {
              ...order,
              status,
              filledQuantity: filledQuantity ?? order.filledQuantity,
              updatedAt: Date.now(),
            }
          : order
      ),
    }));
  },

  cancelOrder: async (id, symbol) => {
    const token = useUserStore.getState().token;
    if (!token) {
      console.error('未登录，无法取消订单');
      return false;
    }

    try {
      const response = await fetch(`/api/user/order?symbol=${symbol}&orderId=${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();

      if (result.success) {
        set((state) => ({
          orders: state.orders.map((order) =>
            order.id === id
              ? { ...order, status: "cancelled" as OrderStatus, updatedAt: Date.now() }
              : order
          ),
        }));
        return true;
      } else {
        console.error('取消订单失败:', result.error);
        return false;
      }
    } catch (error) {
      console.error('取消订单失败:', error);
      return false;
    }
  },

  cancelAllOrders: async (symbol) => {
    const token = useUserStore.getState().token;
    if (!token) {
      console.error('未登录，无法取消订单');
      return false;
    }

    try {
      const response = await fetch(`/api/user/order?symbol=${symbol}&cancelAll=true`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();

      if (result.success) {
        // 清空本地挂单
        set({ realOrders: [] });
        return true;
      } else {
        console.error('取消全部订单失败:', result.error);
        return false;
      }
    } catch (error) {
      console.error('取消全部订单失败:', error);
      return false;
    }
  },

  fetchOpenOrders: async (symbol?: string) => {
    const token = useUserStore.getState().token;
    if (!token) {
      return;
    }

    const { realOrders } = get();
    // 只在首次加载（数据为空）时显示 loading
    if (realOrders.length === 0) {
      set({ isLoadingOrders: true });
    }

    try {
      const url = symbol
        ? `/api/user/orders?symbol=${symbol}`
        : '/api/user/orders';

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();

      if (result.success) {
        set({ realOrders: result.orders });
      }
    } catch (error) {
      console.error('Failed to fetch open orders:', error);
    } finally {
      set({ isLoadingOrders: false });
    }
  },

  getOpenOrders: () => {
    return get().orders.filter(
      (order) => order.status === "pending" || order.status === "partial"
    );
  },

  getOrderHistory: () => {
    return get().orders.filter(
      (order) => order.status === "filled" || order.status === "cancelled"
    );
  },
}));
