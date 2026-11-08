import type { Candle } from "@/types/chart";
import { fetchKlines } from "@/lib/binance/api";

// Rust 后端 WebSocket(与 src/lib/binance/websocket.ts 同源)
const WS_URL = process.env.NEXT_PUBLIC_KLINE_WS || "ws://localhost:3001/ws";

/** 月线周期 —— 大写 M,不能写成 "1m"(那是 1 分钟线) */
export const MONTHLY_INTERVAL = "1M" as const;

interface KlineUpdateData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const toCandle = (k: KlineUpdateData): Candle => ({
  time: k.time,
  open: k.open,
  high: k.high,
  low: k.low,
  close: k.close,
  volume: k.volume,
});

/**
 * 通过 WebSocket 订阅月线,拿后端返回的历史 K 线。
 *
 * 背景:Rust 的 REST /api/klines 只读内存缓存,缓存未预热时返回空数组。
 * 发送 Subscribe 会让后端执行 init_subscription(拉取历史 → 写缓存 → 回推 KlineHistory)。
 */
function fetchMonthlyViaWs(symbol: string, timeoutMs = 10000): Promise<Candle[]> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;

    const finish = (data: Candle[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(data);
    };

    const timer = setTimeout(() => finish([]), timeoutMs);

    try {
      ws = new WebSocket(WS_URL);
    } catch {
      finish([]);
      return;
    }

    ws.onopen = () => {
      ws?.send(
        JSON.stringify({
          type: "Subscribe",
          data: { symbol: symbol.toUpperCase(), timeframe: MONTHLY_INTERVAL },
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "KlineHistory") {
          const klines: KlineUpdateData[] = msg.data?.klines ?? [];
          finish(klines.map(toCandle));
        }
      } catch {
        /* 忽略非 JSON 消息(如 "pong") */
      }
    };

    ws.onerror = () => finish([]);
    ws.onclose = () => finish([]);
  });
}

/**
 * 加载月K 数据(价格带的计算源)。
 *
 * 先走 REST(命中后端缓存最快);返回空说明后端还没预热该周期,
 * 则通过 WebSocket 订阅触发后端初始化,并直接使用回推的历史数据。
 */
export async function loadMonthlyCandles(
  symbol: string,
  limit: number = 500
): Promise<Candle[]> {
  try {
    const cached = await fetchKlines(symbol, MONTHLY_INTERVAL, limit);
    if (cached && cached.length > 0) return cached;
  } catch {
    /* 后端不可用 → 走 WS 兜底 */
  }

  const viaWs = await fetchMonthlyViaWs(symbol);
  if (viaWs.length > 0) return viaWs;

  // 最后再试一次 REST:WS 订阅期间后端可能已经把数据写进缓存
  try {
    const retry = await fetchKlines(symbol, MONTHLY_INTERVAL, limit);
    return retry ?? [];
  } catch {
    return [];
  }
}
