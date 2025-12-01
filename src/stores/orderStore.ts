import { create } from "zustand";
import { Order, OrderFormData, OrderStatus, OrderSide } from "@/types/order";

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

interface OrderState {
  orders: Order[];
  isModalOpen: boolean;
  prefillData: OTEPrefillData | null;
  tradingLines: TradingLine[];

  // Actions
  openModal: () => void;
  closeModal: () => void;
  togglePanel: () => void;
  setPrefillData: (data: OTEPrefillData | null) => void;
  setTradingLines: (lines: TradingLine[]) => void;
  clearTradingLines: () => void;
  addOrder: (data: OrderFormData, symbol: string) => Order;
  updateOrderStatus: (id: string, status: OrderStatus, filledQuantity?: number) => void;
  cancelOrder: (id: string) => void;
  getOpenOrders: () => Order[];
  getOrderHistory: () => Order[];
}

export const useOrderStore = create<OrderState>((set, get) => ({
  orders: [],
  isModalOpen: false,
  prefillData: null,
  tradingLines: [],

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

  cancelOrder: (id) => {
    set((state) => ({
      orders: state.orders.map((order) =>
        order.id === id
          ? { ...order, status: "cancelled" as OrderStatus, updatedAt: Date.now() }
          : order
      ),
    }));
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
