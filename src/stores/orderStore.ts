import { create } from "zustand";
import { Order, OrderFormData, OrderStatus } from "@/types/order";

interface OrderState {
  orders: Order[];
  isModalOpen: boolean;

  // Actions
  openModal: () => void;
  closeModal: () => void;
  togglePanel: () => void;
  addOrder: (data: OrderFormData, symbol: string) => Order;
  updateOrderStatus: (id: string, status: OrderStatus, filledQuantity?: number) => void;
  cancelOrder: (id: string) => void;
  getOpenOrders: () => Order[];
  getOrderHistory: () => Order[];
}

export const useOrderStore = create<OrderState>((set, get) => ({
  orders: [],
  isModalOpen: false,

  openModal: () => set({ isModalOpen: true }),
  closeModal: () => set({ isModalOpen: false }),
  togglePanel: () => set((state) => ({ isModalOpen: !state.isModalOpen })),

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
