import { Position } from "@/types/order";
import { RealOrder } from "@/stores/orderStore";
import { useUserStore } from "@/stores/userStore";

// Binance User Data Stream WebSocket 管理类
// 文档: https://developers.binance.com/docs/simple-earn/history/User-Data-Stream

const BINANCE_USER_WS_URL = "wss://fstream.binance.com/ws";

// WebSocket 消息类型
interface PositionUpdateEvent {
  e: "POSITION_UPDATE";
  s: string;        // 交易对
  pa: string;       // 持仓数量
  ep: string;       // 进入价格
  ps: string;       // 持仓方向: LONG / SHORT
  li: string;       // 强平价格
  sl: string;       // 止损价格
  "tp": string;     // 止盈价格
  m: string;        // 是否为做市商
  b: string;        // 逐仓保证金 (isolated)
  l: string;        // 合约数量
  rv: string;       // 实现盈亏
  p: string;        // 持仓数量
  le: string;       // 杠杆
}

interface OrderUpdateEvent {
  e: "ORDER_TRADE_UPDATE";
  o: {
    s: string;       // 交易对
    c: string;       // 客户端订单ID
    S: string;       // 订单方向: BUY / SELL
    ps: string;      // 持仓方向: LONG / SHORT
    st: string;      // 订单状态
    ot: string;      // 订单类型
    q: string;       // 订单数量
    p: string;       // 订单价格
    sp: string;      // 止损价格
    x: string;       // 订单更新原因
    X: string;       // 订单状态
    i: number;       // 订单ID
    l: string;       // 本次成交数量
    z: string;       // 累计成交数量
    T: number;       // 成交时间
    t: number;       // 成交ID
    b: string;       // 买单数量
    a: string;       // 卖单数量
    m: string;       // 是否做市商
    rp: string;       // 真实收益
    cl: string;       // 触发止损价格
    ap: string;       // 激活价格 (追踪止损)
  };
}

interface ListenKeyExpiredEvent {
  e: "listenKeyExpired";
}

type WsEvent = PositionUpdateEvent | OrderUpdateEvent | ListenKeyExpiredEvent;

export type PositionUpdateCallback = (positions: Position[]) => void;
export type OrderUpdateCallback = (orders: RealOrder[]) => void;

export class BinanceUserWebSocket {
  private ws: WebSocket | null = null;
  private listenKey: string | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isManualDisconnect = false;
  private onPositionUpdate: PositionUpdateCallback | null = null;
  private onOrderUpdate: OrderUpdateCallback | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private lastPositions: Position[] = [];
  private lastOrders: RealOrder[] = [];

  // 获取 listenKey (通过后端 API)
  private async fetchListenKey(): Promise<string | null> {
    try {
      const token = useUserStore.getState().token;
      if (!token) {
        console.error('[UserWebSocket] 未登录，无法获取 listenKey');
        return null;
      }

      const response = await fetch('/api/user/listen-key', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        console.error('[UserWebSocket] 获取 listenKey 失败:', response.status);
        return null;
      }

      const data = await response.json();
      if (data.listenKey) {
        console.log('[UserWebSocket] 获取 listenKey 成功');
        return data.listenKey;
      }
      return null;
    } catch (error) {
      console.error('[UserWebSocket] 获取 listenKey 异常:', error);
      return null;
    }
  }

  // 延长 listenKey 有效期 (每 30 分钟)
  private async extendListenKey(): Promise<boolean> {
    try {
      const token = useUserStore.getState().token;
      if (!token || !this.listenKey) {
        return false;
      }

      const response = await fetch('/api/user/listen-key', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ listenKey: this.listenKey }),
      });

      if (response.ok) {
        console.log('[UserWebSocket] listenKey 续期成功');
        return true;
      } else {
        console.error('[UserWebSocket] listenKey 续期失败:', response.status);
        return false;
      }
    } catch (error) {
      console.error('[UserWebSocket] listenKey 续期异常:', error);
      return false;
    }
  }

  // 关闭 listenKey
  private async closeListenKey(): Promise<void> {
    try {
      const token = useUserStore.getState().token;
      if (!token || !this.listenKey) {
        return;
      }

      await fetch('/api/user/listen-key', {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ listenKey: this.listenKey }),
      });

      console.log('[UserWebSocket] listenKey 已关闭');
    } catch (error) {
      console.error('[UserWebSocket] 关闭 listenKey 异常:', error);
    }
  }

  // 连接 WebSocket
  async connect(
    onPositionUpdate: PositionUpdateCallback,
    onOrderUpdate: OrderUpdateCallback
  ): Promise<void> {
    this.onPositionUpdate = onPositionUpdate;
    this.onOrderUpdate = onOrderUpdate;
    this.isManualDisconnect = false;

    // 获取 listenKey
    const listenKey = await this.fetchListenKey();
    if (!listenKey) {
      console.error('[UserWebSocket] 无法获取 listenKey');
      return;
    }

    this.listenKey = listenKey;

    // 建立 WebSocket 连接
    this.ws = new WebSocket(`${BINANCE_USER_WS_URL}/${listenKey}`);

    this.ws.onopen = () => {
      console.log('[UserWebSocket] 已连接');
      this.reconnectAttempts = 0;

      // 启动心跳 (每 30 分钟续期 listenKey)
      this.startPingInterval();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (error) {
        console.error('[UserWebSocket] 解析消息失败:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[UserWebSocket] 连接错误:', error);
    };

    this.ws.onclose = () => {
      console.log('[UserWebSocket] 连接关闭');
      this.stopPingInterval();

      if (!this.isManualDisconnect) {
        this.attemptReconnect();
      }
    };
  }

  // 处理消息
  private handleMessage(data: WsEvent): void {
    switch (data.e) {
      case 'POSITION_UPDATE':
        this.handlePositionUpdate(data as PositionUpdateEvent);
        break;
      case 'ORDER_TRADE_UPDATE':
        this.handleOrderUpdate(data as OrderUpdateEvent);
        break;
      case 'listenKeyExpired':
        console.warn('[UserWebSocket] listenKey 已过期，需要重新连接');
        this.handleListenKeyExpired();
        break;
    }
  }

  // 处理持仓更新
  private handlePositionUpdate(event: PositionUpdateEvent): void {
    const symbol = event.s;
    const side = event.ps === 'LONG' ? 'long' : 'short';
    const quantity = Math.abs(parseFloat(event.pa));
    const entryPrice = parseFloat(event.ep);
    const liquidationPrice = parseFloat(event.li);
    const stopLoss = event.sl ? parseFloat(event.sl) : undefined;
    const takeProfit = event.tp ? parseFloat(event.tp) : undefined;
    const leverage = event.le ? parseInt(event.le) : undefined;
    const unrealizedPnl = parseFloat(event.rv);

    // 更新或添加持仓
    if (quantity === 0) {
      // 平仓，移除持仓
      this.lastPositions = this.lastPositions.filter(p => p.symbol !== symbol);
    } else {
      const existingIndex = this.lastPositions.findIndex(p => p.symbol === symbol);
      const position: Position = {
        id: `${symbol}_${side.toUpperCase()}`,
        symbol,
        side,
        quantity,
        entryPrice,
        currentPrice: entryPrice, // WebSocket 不提供当前价格，用 entryPrice 代替
        unrealizedPnl,
        unrealizedPnlPercent: entryPrice > 0 ? (unrealizedPnl / (entryPrice * quantity)) * 100 : 0,
        stopLoss,
        takeProfit,
        leverage,
        liquidationPrice,
      };

      if (existingIndex >= 0) {
        this.lastPositions[existingIndex] = position;
      } else {
        this.lastPositions.push(position);
      }
    }

    this.onPositionUpdate?.(this.lastPositions);
  }

  // 处理订单更新
  private handleOrderUpdate(event: OrderUpdateEvent): void {
    const order = event.o;

    // 转换订单数据
    const realOrder: RealOrder = {
      id: order.i.toString(),
      clientOrderId: order.c,
      symbol: order.s,
      side: order.S,
      positionSide: order.ps,
      type: order.ot,
      quantity: parseFloat(order.q),
      price: order.sp ? parseFloat(order.sp) : undefined,
      stopPrice: order.ap ? parseFloat(order.ap) : undefined,
      status: this.convertOrderStatus(order.X),
      time: order.T,
      isAlgo: this.isAlgoOrder(order.ot),
    };

    // 更新或添加订单
    if (realOrder.status === 'NEW' || realOrder.status === 'PARTIALLY_FILLED') {
      const existingIndex = this.lastOrders.findIndex(o => o.id === realOrder.id);
      if (existingIndex >= 0) {
        this.lastOrders[existingIndex] = realOrder;
      } else {
        this.lastOrders.unshift(realOrder);
      }
    } else {
      // 订单已成交或取消，从列表移除
      this.lastOrders = this.lastOrders.filter(o => o.id !== realOrder.id);
    }

    this.onOrderUpdate?.(this.lastOrders);
  }

  // 转换订单状态
  private convertOrderStatus(status: string): string {
    const statusMap: Record<string, string> = {
      'NEW': 'NEW',
      'PARTIALLY_FILLED': 'PARTIALLY_FILLED',
      'FILLED': 'FILLED',
      'CANCELED': 'CANCELED',
      'REJECTED': 'REJECTED',
      'EXPIRED': 'EXPIRED',
    };
    return statusMap[status] || status;
  }

  // 判断是否为 Algo 订单 (止盈止损/追踪止损)
  private isAlgoOrder(type: string): boolean {
    const algoTypes = ['STOP', 'TAKE_PROFIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET'];
    return algoTypes.some(t => type.includes(t));
  }

  // listenKey 过期处理
  private handleListenKeyExpired(): void {
    this.listenKey = null;
    this.scheduleReconnect();
  }

  // 启动心跳
  private startPingInterval(): void {
    this.stopPingInterval();

    // 每 30 分钟续期一次 (55 分钟，以防提前过期)
    this.pingInterval = setInterval(() => {
      this.extendListenKey();
    }, 55 * 60 * 1000);

    console.log('[UserWebSocket] 心跳已启动 (每 55 分钟续期)');
  }

  // 停止心跳
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // 安排重连
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[UserWebSocket] 达到最大重连次数，停止重连');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 30000);

    console.log(`[UserWebSocket] ${delay / 1000}秒后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      if (this.onPositionUpdate && this.onOrderUpdate) {
        this.connect(this.onPositionUpdate, this.onOrderUpdate);
      }
    }, delay);
  }

  // 尝试重连
  private attemptReconnect(): void {
    this.scheduleReconnect();
  }

  // 断开连接
  async disconnect(): Promise<void> {
    this.isManualDisconnect = true;

    // 停止心跳
    this.stopPingInterval();

    // 清除重连定时器
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // 关闭 WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // 关闭 listenKey
    await this.closeListenKey();

    this.listenKey = null;
    console.log('[UserWebSocket] 已断开');
  }

  // 获取当前持仓
  getPositions(): Position[] {
    return this.lastPositions;
  }

  // 获取当前订单
  getOrders(): RealOrder[] {
    return this.lastOrders;
  }

  // 是否已连接
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
