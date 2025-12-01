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
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private lastKlineTime: number = 0;
  private pingInterval: NodeJS.Timeout | null = null;

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
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);

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

  private attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(
        `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
      );

      setTimeout(() => {
        this.connect();
      }, this.reconnectDelay * this.reconnectAttempts);
    }
  }

  disconnect() {
    this.stopPing();
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
