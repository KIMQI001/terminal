import { Candle, Timeframe } from "@/types/chart";

// Rust 后端 WebSocket
const WS_URL = process.env.NEXT_PUBLIC_KLINE_WS || "ws://localhost:3001/ws";

export type KlineCallback = (candle: Candle, isClosed: boolean) => void;

// Rust 后端 WebSocket 消息类型
interface WsMessage {
  type: "KlineUpdate" | "KlineHistory" | "Error" | "Pong";
  data?: unknown;
}

// K线数据结构
interface KlineUpdateData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// KlineUpdate 消息格式：{ type: "KlineUpdate", data: KlineUpdateData }
interface KlineUpdateMessage {
  type: "KlineUpdate";
  data: KlineUpdateData;
}

interface KlineHistoryData {
  symbol: string;
  timeframe: string;
  klines: KlineUpdateData[];
}

// 根据 timeframe 动态调整超时时间（低频周期需要更长的超时）
// 注意：Timeframe 类型可能不包含所有这里定义的周期，使用可选链和默认值处理
const TIMEFRAME_TIMEOUT_MS: Record<string, number> = {
  '1m': 15000,
  '3m': 20000,
  '5m': 30000,
  '15m': 45000,
  '30m': 60000,
  '1h': 90000,
  '2h': 180000,
  '4h': 300000,
  '6h': 450000,
  '8h': 600000,
  '12h': 900000,
  '1d': 1800000,
  '4d': 7200000,
  '1w': 28800000,
};

export class BinanceWebSocket {
  private ws: WebSocket | null = null;
  private symbol: string;
  private interval: Timeframe;
  private onKline: KlineCallback;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 100; // 最多重连 100 次
  private reconnectDelay = 1000;
  private lastKlineTime: number = 0;
  private dataTimeout: NodeJS.Timeout | null = null;
  private lastDataTime: number = 0;
  private dataTimeoutMs: number;

  constructor(
    symbol: string,
    interval: Timeframe,
    onKline: KlineCallback
  ) {
    this.symbol = symbol.toUpperCase();
    this.interval = interval;
    this.onKline = onKline;
    // 根据 timeframe 设置超时时间
    this.dataTimeoutMs = TIMEFRAME_TIMEOUT_MS[interval] || 15000;
  }

  connect() {
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log("WebSocket connected to Rust backend");
      this.reconnectAttempts = 0;

      // 发送订阅消息
      this.sendSubscribe();

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

        const msg = JSON.parse(data);

        switch (msg.type) {
          case "KlineUpdate":
            // 格式: { type: "KlineUpdate", data: { time, open, high, low, close, volume } }
            this.handleKlineUpdate(msg.data as KlineUpdateData);
            break;
          case "KlineHistory":
            // 格式: { type: "KlineHistory", data: { symbol, timeframe, klines: [...] } }
            this.handleKlineHistory(msg.data as KlineHistoryData);
            break;
          case "Error":
            console.error("WebSocket error:", msg.data?.message || msg.data);
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

  private startDataTimeout() {
    this.lastDataTime = Date.now();
    this.stopDataTimeout();

    this.dataTimeout = setInterval(() => {
      const timeSinceLastData = Date.now() - this.lastDataTime;
      if (timeSinceLastData > this.dataTimeoutMs) {
        console.warn(`WebSocket 数据超时 (${Math.round(timeSinceLastData / 1000)}s > ${this.dataTimeoutMs / 1000}s)，触发重连...`);
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
