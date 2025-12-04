// 订单类型
export type OrderType = "limit" | "market" | "stop-limit" | "stop-market";
export type OrderSide = "buy" | "sell";
export type OrderStatus = "pending" | "filled" | "partial" | "cancelled";

// 订单接口
export interface Order {
  id: string;
  symbol: string;
  type: OrderType;
  side: OrderSide;
  price?: number;
  stopPrice?: number;
  quantity: number;
  filledQuantity: number;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}

// 持仓接口
export interface Position {
  id: string;
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  liquidationPrice?: number;
}

// 下单表单数据
export interface OrderFormData {
  type: OrderType;
  side: OrderSide;
  price?: number;
  stopPrice?: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  clientOrderIdPrefix?: string;  // 自定义订单 ID 前缀，如 "ict_tower"
}

// 账户余额
export interface Balance {
  asset: string;
  free: number;
  locked: number;
}
