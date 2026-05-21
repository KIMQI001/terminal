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
  clientOrderId: string;
  symbol: string;
  side: string;
  positionSide: string;
  type: string;
  quantity: number;
  price?: number;
  stopPrice?: number;
  status: string;
  time: number;
  isAlgo?: boolean;         // 是否为 Algo 条件单
  callbackRate?: number;    // 追踪止盈回调比例
}

// 获取订单类型优先级（限价 < 止盈 < 止损）
const getTypeOrder = (type: string): number => {
  if (type.includes('limit') && !type.includes('stop')) return 0;
  if (type.includes('profit')) return 1;
  if (type.includes('stop')) return 2;
  return 3;
};

// 从 clientOrderId 提取基础 ID（去掉 _sl, _tp, _r1 等后缀）
// 格式: prefix_timestamp 或 prefix_timestamp_sl 或 prefix_timestamp_tp
const extractBaseClientOrderId = (clientOrderId: string): string | null => {
  if (!clientOrderId) return null;
  // 去掉 _sl, _tp, _r1, _r2 等后缀
  return clientOrderId.replace(/_(sl|tp|r\d+)$/g, '');
};

// 按 clientOrderId 分组订单（同一笔交易的主单、止盈、止损）
// 如果没有 clientOrderId，则回退到时间+数量分组
export const groupOrders = (orders: RealOrder[]): RealOrder[][] => {
  if (orders.length === 0) return [];

  const groups: RealOrder[][] = [];
  const used = new Set<string>();

  // 按时间排序（最新的在前）
  const sorted = [...orders].sort((a, b) => b.time - a.time);

  // 第一步：按 clientOrderId 分组
  const clientIdGroups = new Map<string, RealOrder[]>();

  for (const order of sorted) {
    const baseId = extractBaseClientOrderId(order.clientOrderId);
    if (baseId) {
      if (!clientIdGroups.has(baseId)) {
        clientIdGroups.set(baseId, []);
      }
      clientIdGroups.get(baseId)!.push(order);
      used.add(order.id);
    }
  }

  // 添加 clientOrderId 分组
  for (const group of clientIdGroups.values()) {
    // 组内按类型排序：限价 → 止盈 → 止损
    group.sort((a, b) => getTypeOrder(a.type) - getTypeOrder(b.type));
    groups.push(group);
  }

  // 第二步：剩余没有 clientOrderId 的订单，用时间+数量分组
  for (const order of sorted) {
    if (used.has(order.id)) continue;

    // 找同数量且同时间（2秒内）的订单
    const group = sorted.filter(o =>
      !used.has(o.id) &&
      o.quantity === order.quantity &&
      Math.abs(o.time - order.time) < 2000
    );

    group.forEach(o => used.add(o.id));

    // 组内按类型排序：限价 → 止盈 → 止损
    group.sort((a, b) => getTypeOrder(a.type) - getTypeOrder(b.type));

    groups.push(group);
  }

  // 按第一个订单的时间排序（最新的组在前）
  groups.sort((a, b) => b[0].time - a[0].time);

  return groups;
};

interface OrderState {
  orders: Order[];
  realOrders: RealOrder[];
  isLoadingOrders: boolean;
  isModalOpen: boolean;
  prefillData: OTEPrefillData | null;
  tradingLines: TradingLine[];
  isPlacingOrder: boolean;
  orderError: string | null;
  eventSource: EventSource | null;
  wsConnected: boolean;

  // Actions
  openModal: () => void;
  closeModal: () => void;
  togglePanel: () => void;
  setPrefillData: (data: OTEPrefillData | null) => void;
  setTradingLines: (lines: TradingLine[]) => void;
  clearTradingLines: () => void;
  addOrder: (data: OrderFormData, symbol: string) => Order;
  placeOrder: (data: OrderFormData, symbol: string) => Promise<{ success: boolean; error?: string; warnings?: string[] }>;
  updateOrderStatus: (id: string, status: OrderStatus, filledQuantity?: number) => void;
  updateOrders: (orders: RealOrder[]) => void;
  cancelOrder: (id: string, symbol: string, isAlgo?: boolean) => Promise<boolean>;
  cancelAllOrders: (symbol: string) => Promise<boolean>;
  fetchOpenOrders: (symbol?: string) => Promise<void>;
  getOpenOrders: () => Order[];
  getOrderHistory: () => Order[];
  initUserWebSocket: () => Promise<void>;
  disconnectUserWebSocket: () => Promise<void>;
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
  eventSource: null,
  wsConnected: false,

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
          clientOrderIdPrefix: data.clientOrderIdPrefix,  // 订单 ID 前缀
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

        // 检查止盈止损警告
        if (result.warnings?.length > 0) {
          console.warn('下单警告:', result.warnings);
          return { success: true, warnings: result.warnings };
        }

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

  updateOrders: (orders) => {
    set({ realOrders: orders });
  },

  cancelOrder: async (id, symbol, isAlgo?: boolean) => {
    const token = useUserStore.getState().token;
    if (!token) {
      console.error('未登录，无法取消订单');
      return false;
    }

    try {
      let url = `/api/user/order?symbol=${symbol}&orderId=${id}`;
      if (isAlgo) {
        url += '&isAlgo=true';
      }

      const response = await fetch(url, {
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

    const { realOrders, wsConnected } = get();

    // 如果 WebSocket 已连接且有数据，跳过 REST API 调用（WebSocket 会实时推送更新）
    // 这样可以避免频繁调用 REST API 触发 Binance 限流
    if (wsConnected && realOrders.length > 0) {
      console.log('[OrderStore] WebSocket 已连接，跳过 REST API 获取挂单');
      return;
    }

    // WebSocket 未连接或没有数据时，才用 REST API（作为后备）
    console.log('[OrderStore] WebSocket 未连接，使用 REST API 获取挂单');

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

  initUserWebSocket: async () => {
    const { eventSource } = get();
    if (eventSource) {
      // 已存在，先断开
      eventSource.close();
    }

    // 创建 SSE 连接订阅后端订单更新
    const ws = new EventSource('/api/user/order-stream');

    ws.onopen = () => {
      console.log('[OrderStore] SSE 连接已打开');
      set({ wsConnected: true });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // 处理订单更新
        if (data.type === 'order' && data.data) {
          const { order } = data.data;

          // 转换订单数据格式
          const realOrder: RealOrder = {
            id: order.orderId?.toString() || '',
            clientOrderId: order.clientOrderId || '',
            symbol: order.symbol,
            side: order.side,
            positionSide: order.positionSide,
            type: order.orderType,
            quantity: parseFloat(order.originalQuantity || order.quantity || '0'),
            price: order.price ? parseFloat(order.price) : undefined,
            stopPrice: order.stopPrice ? parseFloat(order.stopPrice) : undefined,
            status: order.orderStatus,
            time: order.orderTime || order.time || Date.now(),
            isAlgo: ['STOP', 'TAKE_PROFIT', 'TRAILING_STOP_MARKET'].includes(order.orderType),
          };

          // 更新本地订单列表
          const { realOrders } = get();
          const existingIndex = realOrders.findIndex(o => o.id === realOrder.id);

          if (existingIndex >= 0) {
            // 更新现有订单
            const updated = [...realOrders];
            updated[existingIndex] = realOrder;
            set({ realOrders: updated });
          } else {
            // 添加新订单
            set({ realOrders: [realOrder, ...realOrders] });
          }
        }

        // 处理连接状态
        if (data.type === 'connected') {
          console.log('[OrderStore] 后端 WebSocket 已连接');
          set({ wsConnected: true });
        }
        if (data.type === 'disconnected') {
          console.log('[OrderStore] 后端 WebSocket 已断开');
          set({ wsConnected: false });
        }
        if (data.type === 'error') {
          console.error('[OrderStore] SSE 错误:', data.message);
        }
      } catch (error) {
        console.error('[OrderStore] 解析 SSE 数据失败:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('[OrderStore] SSE 错误:', error);
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
