/**
 * Binance User Data Stream 管理
 * 用于实时监听订单成交事件
 */

import WebSocket from 'ws';

// 订单更新事件
export interface OrderTradeUpdateEvent {
  eventType: 'ORDER_TRADE_UPDATE';
  eventTime: number;
  transactionTime: number;
  order: {
    symbol: string;
    clientOrderId: string;
    side: 'BUY' | 'SELL';
    orderType: string;
    timeInForce: string;
    originalQuantity: string;
    originalPrice: string;
    averagePrice: string;
    stopPrice: string;
    executionType: string;       // NEW, TRADE, CANCELED, EXPIRED
    orderStatus: string;         // NEW, FILLED, CANCELED, EXPIRED
    orderId: number;
    lastFilledQuantity: string;
    accumulatedFilledQuantity: string;
    lastFilledPrice: string;
    commissionAsset: string;
    commission: string;
    orderTime: number;
    tradeId: number;
    positionSide: string;        // LONG, SHORT
    realizedProfit: string;
    isMaker: boolean;
  };
}

export interface UserDataStreamConfig {
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
  onOrderUpdate: (event: OrderTradeUpdateEvent) => void;
  onError?: (error: Error) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export class UserDataStreamManager {
  private listenKey: string | null = null;
  private ws: WebSocket | null = null;
  private renewInterval: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isRunning = false;

  constructor(private config: UserDataStreamConfig) {}

  /**
   * 获取 listenKey
   */
  private async getListenKey(): Promise<string> {
    const baseUrl = this.config.isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    const response = await fetch(`${baseUrl}/fapi/v1/listenKey`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': this.config.apiKey },
    });

    if (!response.ok) {
      const error = await response.json() as { msg?: string };
      throw new Error(`获取 listenKey 失败: ${error.msg || response.statusText}`);
    }

    const data = await response.json() as { listenKey: string };
    return data.listenKey;
  }

  /**
   * 续期 listenKey (每 30 分钟调用一次)
   */
  private async renewListenKey(): Promise<void> {
    if (!this.listenKey) return;

    const baseUrl = this.config.isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    try {
      const response = await fetch(`${baseUrl}/fapi/v1/listenKey`, {
        method: 'PUT',
        headers: { 'X-MBX-APIKEY': this.config.apiKey },
      });

      if (response.ok) {
        console.log('[UserDataStream] listenKey 续期成功');
      } else {
        console.warn('[UserDataStream] listenKey 续期失败，尝试重新获取');
        this.listenKey = await this.getListenKey();
        this.reconnect();
      }
    } catch (error) {
      console.error('[UserDataStream] listenKey 续期错误:', error);
    }
  }

  /**
   * 启动 User Data Stream
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[UserDataStream] 已在运行中');
      return;
    }

    console.log('[UserDataStream] 启动中...');
    this.isRunning = true;

    try {
      this.listenKey = await this.getListenKey();
      console.log('[UserDataStream] 获取 listenKey 成功');

      this.connect();
      this.startRenewInterval();
    } catch (error) {
      console.error('[UserDataStream] 启动失败:', error);
      this.isRunning = false;
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * 建立 WebSocket 连接
   */
  private connect(): void {
    if (!this.listenKey) return;

    const wsUrl = this.config.isTestnet
      ? `wss://stream.binancefuture.com/ws/${this.listenKey}`
      : `wss://fstream.binance.com/ws/${this.listenKey}`;

    console.log('[UserDataStream] 连接 WebSocket:', wsUrl.substring(0, 50) + '...');

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('[UserDataStream] WebSocket 连接已建立');
      this.reconnectAttempts = 0;
      this.startPingInterval();
      this.config.onConnected?.();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString());

        // 处理订单更新事件
        if (event.e === 'ORDER_TRADE_UPDATE') {
          const parsed = this.parseOrderEvent(event);
          this.config.onOrderUpdate(parsed);
        }
        // 也可处理其他事件如 ACCOUNT_UPDATE 等
      } catch (error) {
        console.error('[UserDataStream] 解析消息失败:', error);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[UserDataStream] WebSocket 连接关闭: ${code} - ${reason.toString()}`);
      this.stopPingInterval();
      this.config.onDisconnected?.();

      if (this.isRunning) {
        this.handleReconnect();
      }
    });

    this.ws.on('error', (error) => {
      console.error('[UserDataStream] WebSocket 错误:', error);
      this.config.onError?.(error);
    });

    this.ws.on('pong', () => {
      // 收到 pong 响应，连接正常
    });
  }

  /**
   * 解析订单事件
   */
  private parseOrderEvent(raw: Record<string, unknown>): OrderTradeUpdateEvent {
    const o = raw.o as Record<string, unknown>;

    return {
      eventType: 'ORDER_TRADE_UPDATE',
      eventTime: raw.E as number,
      transactionTime: raw.T as number,
      order: {
        symbol: o.s as string,
        clientOrderId: o.c as string,
        side: o.S as 'BUY' | 'SELL',
        orderType: o.o as string,
        timeInForce: o.f as string,
        originalQuantity: o.q as string,
        originalPrice: o.p as string,
        averagePrice: o.ap as string,
        stopPrice: o.sp as string,
        executionType: o.x as string,
        orderStatus: o.X as string,
        orderId: o.i as number,
        lastFilledQuantity: o.l as string,
        accumulatedFilledQuantity: o.z as string,
        lastFilledPrice: o.L as string,
        commissionAsset: o.N as string,
        commission: o.n as string,
        orderTime: o.T as number,
        tradeId: o.t as number,
        positionSide: o.ps as string,
        realizedProfit: o.rp as string,
        isMaker: o.m as boolean,
      },
    };
  }

  /**
   * 启动续期定时器 (每 30 分钟)
   */
  private startRenewInterval(): void {
    if (this.renewInterval) {
      clearInterval(this.renewInterval);
    }

    this.renewInterval = setInterval(() => {
      this.renewListenKey();
    }, 30 * 60 * 1000); // 30 分钟
  }

  /**
   * 启动心跳检测 (每 3 分钟发送 ping)
   */
  private startPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 3 * 60 * 1000); // 3 分钟
  }

  /**
   * 停止心跳检测
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * 处理重连
   */
  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[UserDataStream] 达到最大重连次数，停止重连');
      this.isRunning = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000); // 最大 60 秒

    console.log(`[UserDataStream] ${delay / 1000}秒后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        // 重新获取 listenKey
        this.listenKey = await this.getListenKey();
        this.connect();
      } catch (error) {
        console.error('[UserDataStream] 重连失败:', error);
        this.handleReconnect();
      }
    }, delay);
  }

  /**
   * 手动重连
   */
  private reconnect(): void {
    if (this.ws) {
      this.ws.close();
    }
    this.connect();
  }

  /**
   * 停止 User Data Stream
   */
  stop(): void {
    console.log('[UserDataStream] 停止中...');
    this.isRunning = false;

    if (this.renewInterval) {
      clearInterval(this.renewInterval);
      this.renewInterval = null;
    }

    this.stopPingInterval();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.listenKey = null;
    console.log('[UserDataStream] 已停止');
  }

  /**
   * 检查是否正在运行
   */
  isActive(): boolean {
    return this.isRunning && this.ws?.readyState === WebSocket.OPEN;
  }
}
