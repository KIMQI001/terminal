import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';

// Get relay WebSocket URL from environment
const RELAY_WS_URL = process.env.COINANK_RELAY_WS || 'ws://localhost:3001/ws/coinank/api';

// Request timeout in milliseconds
const REQUEST_TIMEOUT = 35000;

interface RelayMessage {
  action: string;
  request_id?: string;
  symbol?: string;
  interval?: string;
  data?: unknown;
  success?: boolean;
  error?: string;
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
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let ws: WebSocket | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close errors
        }
        ws = null;
      }
    };

    const resolveOnce = (result: LiquidationResponse) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(result);
      }
    };

    const rejectOnce = (error: Error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(error);
      }
    };

    // Set timeout
    timeoutId = setTimeout(() => {
      rejectOnce(new Error('Request timeout - no tampermonkey client connected?'));
    }, REQUEST_TIMEOUT);

    try {
      ws = new WebSocket(RELAY_WS_URL);

      ws.on('open', () => {
        // Send fetch request
        const request: RelayMessage = {
          action: 'fetch',
          symbol: symbol.toUpperCase(),
          interval,
          request_id: requestId,
        };
        ws?.send(JSON.stringify(request));
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const message: RelayMessage = JSON.parse(data.toString());

          // Check if this is our response
          if (message.request_id === requestId) {
            if (message.action === 'data' && message.success) {
              resolveOnce({
                success: true,
                data: message.data,
                symbol: message.symbol,
                interval: message.interval,
                timestamp: message.timestamp,
              });
            } else if (message.action === 'error' || !message.success) {
              resolveOnce({
                success: false,
                error: message.error || 'Request failed',
                symbol: message.symbol,
                interval: message.interval,
              });
            }
          }
        } catch (e) {
          console.error('Failed to parse relay message:', e);
        }
      });

      ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
        rejectOnce(new Error(`WebSocket connection failed: ${error.message}`));
      });

      ws.on('close', () => {
        // If we haven't received a response yet, treat close as error
        if (!resolved) {
          rejectOnce(new Error('WebSocket connection closed before receiving response'));
        }
      });
    } catch (error) {
      rejectOnce(error instanceof Error ? error : new Error('Unknown error'));
    }
  });
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
  return new Promise((resolve) => {
    const statusUrl = RELAY_WS_URL.replace('/ws/coinank/api', '/ws/coinank/status')
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');

    fetch(statusUrl)
      .then((res) => res.text())
      .then((text) => resolve(text.includes('connected')))
      .catch(() => resolve(false));
  });
}
