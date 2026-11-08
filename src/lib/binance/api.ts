import { Candle, Timeframe } from "@/types/chart";
import { BinanceSymbol, BinanceTicker } from "@/types/binance";

// Rust 后端 API
const KLINE_API_URL = process.env.NEXT_PUBLIC_KLINE_API || "http://localhost:3001";
// Binance API (用于 symbols 和 ticker)
const BINANCE_URL = "https://api.binance.com/api/v3";

/**
 * 可请求的周期。
 * "1M" 是**月线** —— Binance 的月线必须保留大写 M(与 1 分钟线 "1m" 只差大小写),
 * Rust 端 kline-server 会原样透传给 Binance。
 */
export type KlineInterval = Timeframe | "1M";

export async function fetchKlines(
  symbol: string,
  interval: KlineInterval,
  limit: number = 500
): Promise<Candle[]> {
  // 使用 Rust 后端获取 K 线数据
  const response = await fetch(
    `${KLINE_API_URL}/api/klines/${symbol.toUpperCase()}/${interval}?limit=${limit}`
  );

  if (!response.ok) {
    throw new Error("Failed to fetch klines");
  }

  const data = await response.json();

  // Rust 后端返回 { symbol, timeframe, klines: [...] }
  // 每个 kline 格式：{ time, open, high, low, close, volume }
  return data.klines;
}

export async function fetchSymbols(): Promise<BinanceSymbol[]> {
  const response = await fetch(`${BINANCE_URL}/exchangeInfo`);

  if (!response.ok) {
    throw new Error("Failed to fetch symbols");
  }

  const data = await response.json();

  return data.symbols
    .filter(
      (s: BinanceSymbol) =>
        s.status === "TRADING" && s.quoteAsset === "USDT"
    )
    .map((s: BinanceSymbol) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      status: s.status,
    }));
}

export async function fetchTicker(symbol: string): Promise<BinanceTicker> {
  const response = await fetch(`${BINANCE_URL}/ticker/24hr?symbol=${symbol}`);

  if (!response.ok) {
    throw new Error("Failed to fetch ticker");
  }

  return response.json();
}
