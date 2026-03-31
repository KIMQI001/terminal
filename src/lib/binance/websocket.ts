import { Candle, Timeframe } from "@/types/chart";

// Rust 后端 WebSocket
const WS_URL = process.env.NEXT_PUBLIC_KLINE_WS || "ws://localhost:3001/ws";

export type KlineCallback = (candle: Candle, isClosed: boolean) => void;

// Rust 后端 WebSocket 消息类型
interface WsMessage {
  type: "KlineUpdate" | "KlineHistory" | "Error" | "Pong";
  data?: unknown;
}

interface KlineUpdateData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface KlineHistoryData {
  symbol: string;
  timeframe: string;
  klines: KlineUpdateData[];
}

export class BinanceWebSocket {
  private ws: WebSocket | null = null;
  private symbol: string;
  private interval: Timeframe;
  private onKline: KlineCallback;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 100; // 最多重连 100 次
  private reconnectDelay = 1000;
  private lastKlineTime: number = 0;
  private pingInterval: NodeJS.Timeout | null = null;
  private dataTimeout: NodeJS.Timeout | null = null;
  private lastDataTime: number = 0;
  private readonly DATA_TIMEOUT_MS = 15000; // 15秒无数据则重连

  constructor(
    symbol: string,
    interval: Timeframe,
    onKline: KlineCallback
  ) {
    this.symbol = symbol.toUpperCase();
    this.interval = interval;
    this.onKline = onKline;
  }

  connect() {
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log("WebSocket connected to Rust backend");
      this.reconnectAttempts = 0;

      // 发送订阅消息
      this.sendSubscribe();

      // 启动心跳
      this.startPing();

      // 启动数据超时检测
      this.startDataTimeout();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = event.data;

        // 处理 Rust 直接发送的 "pong" 文本
        if (data === "pong") {
          return;
        }

        const msg: WsMessage = JSON.parse(data);

        switch (msg.type) {
          case "KlineUpdate":
            this.handleKlineUpdate(msg.data as KlineUpdateData);
            break;
          case "KlineHistory":
            this.handleKlineHistory(msg.data as KlineHistoryData);
            break;
          case "Error":
            console.error("WebSocket error:", msg.data);
            break;
          case "Pong":
            // 心跳响应
            break;
        }
      } catch (error) {
        console.error("Error parsing WebSocket message:", error);
      }
    };

    this.ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    this.ws.onclose = () => {
      console.log("WebSocket disconnected");
      this.stopPing();
      this.stopDataTimeout();
      this.attemptReconnect();
    };
  }

  private sendSubscribe() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = {
        type: "Subscribe",
        data: {
          symbol: this.symbol,
          timeframe: this.interval
        }
      };
      this.ws.send(JSON.stringify(msg));
      console.log(`Subscribed to ${this.symbol}@${this.interval}`);
    }
  }

  private handleKlineUpdate(data: KlineUpdateData) {
    // 更新最后收到数据的时间（用于超时检测）
    this.lastDataTime = Date.now();

    // 判断是否是新K线（收盘）
    const isClosed = data.time > this.lastKlineTime && this.lastKlineTime !== 0;
    if (data.time > this.lastKlineTime) {
      this.lastKlineTime = data.time;
    }

    const candle: Candle = {
      time: data.time,
      open: data.open,
      high: data.high,
      low: data.low,
      close: data.close,
      volume: data.volume,
    };

    this.onKline(candle, isClosed);
  }

  private handleKlineHistory(data: KlineHistoryData) {
    // 历史数据通过 REST API 获取，这里忽略
    // 如果需要可以添加回调处理
    console.log(`Received ${data.klines.length} historical klines for ${data.symbol}@${data.timeframe}`);
  }

  private startPing() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // 发送符合 WsMessage 格式的 JSON Ping
        this.ws.send(JSON.stringify({ type: "Ping" }));
      }
    }, 30000);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private startDataTimeout() {
    this.lastDataTime = Date.now();
    this.stopDataTimeout();

    this.dataTimeout = setInterval(() => {
      const timeSinceLastData = Date.now() - this.lastDataTime;
      if (timeSinceLastData > this.DATA_TIMEOUT_MS) {
        console.warn(`WebSocket 数据超时 (${Math.round(timeSinceLastData / 1000)}s)，触发重连...`);
        this.forceReconnect();
      }
    }, 10000); // 每 10 秒检查一次
  }

  private stopDataTimeout() {
    if (this.dataTimeout) {
      clearInterval(this.dataTimeout);
      this.dataTimeout = null;
    }
  }

  private forceReconnect() {
    this.stopPing();
    this.stopDataTimeout();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    // 立即重连
    setTimeout(() => this.connect(), 1000);
  }

  private attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(
        `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
      );

      // 先关闭旧连接
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }

      // 重连延迟最多30秒，避免指数增长
      const delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 30000);
      setTimeout(() => {
        this.connect();
      }, delay);
    }
  }

  disconnect() {
    this.stopPing();
    this.stopDataTimeout();
    if (this.ws) {
      // 发送取消订阅
      if (this.ws.readyState === WebSocket.OPEN) {
        const msg = {
          type: "Unsubscribe",
          data: {
            symbol: this.symbol,
            timeframe: this.interval
          }
        };
        this.ws.send(JSON.stringify(msg));
      }
      this.ws.close();
      this.ws = null;
    }
  }

  updateConfig(symbol: string, interval: Timeframe) {
    // 先取消订阅旧的
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const unsubMsg = {
        type: "Unsubscribe",
        data: {
          symbol: this.symbol,
          timeframe: this.interval
        }
      };
      this.ws.send(JSON.stringify(unsubMsg));
    }

    this.symbol = symbol.toUpperCase();
    this.interval = interval;
    this.lastKlineTime = 0;

    // 订阅新的
    this.sendSubscribe();
  }
}
