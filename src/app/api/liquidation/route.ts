import { NextRequest, NextResponse } from 'next/server';

// Get relay HTTP URL from environment
// Use HTTP API instead of WebSocket to avoid ws library bundling issues in Next.js
// 使用 127.0.0.1 而不是 localhost 避免 IPv6 解析问题
const RELAY_HTTP_URL = process.env.COINANK_RELAY_HTTP || 'http://127.0.0.1:3001/api/coinank/fetch';

// Request timeout in milliseconds
const REQUEST_TIMEOUT = 35000;

interface RelayResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  symbol: string;
  interval: string;
  timestamp?: string;
}

interface LiquidationResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  symbol?: string;
  interval?: string;
  timestamp?: string;
}

// GET /api/liquidation?symbol=BTC&interval=1d
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const symbol = searchParams.get('symbol') || 'BTC';
  const interval = searchParams.get('interval') || '1d';

  try {
    const data = await fetchLiquidationData(symbol, interval);
    return NextResponse.json<LiquidationResponse>(data);
  } catch (error) {
    console.error('Liquidation API error:', error);
    return NextResponse.json<LiquidationResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

async function fetchLiquidationData(
  symbol: string,
  interval: string
): Promise<LiquidationResponse> {
  const url = `${RELAY_HTTP_URL}?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${encodeURIComponent(interval)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result: RelayResponse = await response.json();

    if (result.success) {
      return {
        success: true,
        data: result.data,
        symbol: result.symbol,
        interval: result.interval,
        timestamp: result.timestamp,
      };
    } else {
      return {
        success: false,
        error: result.error || 'Request failed',
        symbol: result.symbol,
        interval: result.interval,
      };
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timeout - no tampermonkey client connected?');
    }

    throw error;
  }
}

// Status endpoint to check relay connection
export async function HEAD() {
  try {
    const status = await checkRelayStatus();
    return new NextResponse(null, {
      status: status ? 200 : 503,
      headers: {
        'X-Relay-Status': status ? 'connected' : 'disconnected',
      },
    });
  } catch {
    return new NextResponse(null, { status: 503 });
  }
}

async function checkRelayStatus(): Promise<boolean> {
  const statusUrl = RELAY_HTTP_URL
    .replace('/api/coinank/fetch', '/ws/coinank/status');

  try {
    const response = await fetch(statusUrl);
    const text = await response.text();
    return text.includes('connected');
  } catch {
    return false;
  }
}
