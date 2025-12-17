/**
 * AI 托管 API 代理
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || 'http://127.0.0.1:3002';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get('userId');
    const symbol = searchParams.get('symbol') || 'BTCUSDC';

    if (!userId) {
      return NextResponse.json(
        { success: false, error: '缺少 userId 参数' },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${ANALYSIS_SERVICE_URL}/api/ai-management?userId=${userId}&symbol=${symbol}`
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[ai-management] GET error:', error);
    return NextResponse.json(
      { success: false, error: '服务不可用' },
      { status: 503 }
    );
  }
}
