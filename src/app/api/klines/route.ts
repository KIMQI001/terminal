/**
 * K线数据 API
 * GET /api/klines?symbol=BTC&interval=1h&limit=200
 * 代理到 kline-server (Rust)，保持与前端 fetchKlines 一致的数据源
 */
import { NextRequest, NextResponse } from 'next/server';

const KLINE_API_URL = process.env.NEXT_PUBLIC_KLINE_API || "http://localhost:3001";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const symbol = searchParams.get('symbol') || 'BTC';
  const interval = searchParams.get('interval') || '1h';
  const limit = parseInt(searchParams.get('limit') || '200');

  try {
    // 代理到 kline-server，与 src/lib/binance/api.ts 保持一致
    const res = await fetch(
      `${KLINE_API_URL}/api/klines/${symbol.toUpperCase()}/${interval}?limit=${limit}`
    );

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch klines' }, { status: 500 });
    }

    const data = await res.json();

    // kline-server 返回 { symbol, timeframe, klines: [...] }
    // 每个 kline 格式：{ time, open, high, low, close, volume }
    return NextResponse.json({
      symbol: data.symbol,
      interval,
      candles: data.klines,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[Klines API] Error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
