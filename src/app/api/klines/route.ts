/**
 * K线数据 API
 * GET /api/klines?symbol=BTC&interval=1h&limit=200
 */
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const symbol = searchParams.get('symbol') || 'BTC';
  const interval = searchParams.get('interval') || '1h';
  const limit = parseInt(searchParams.get('limit') || '200');

  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`
    );

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch klines' }, { status: 500 });
    }

    const data = await res.json();

    const candles = data.map((k: [number, string, string, string, string, string, number]) => ({
      time: k[0] / 1000,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    return NextResponse.json({
      symbol,
      interval,
      candles,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[Klines API] Error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
