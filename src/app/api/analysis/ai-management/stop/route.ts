/**
 * AI 托管停止 API 代理
 */

import { NextRequest, NextResponse } from 'next/server';

const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || 'http://127.0.0.1:3002';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const response = await fetch(`${ANALYSIS_SERVICE_URL}/api/ai-management/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[ai-management/stop] POST error:', error);
    return NextResponse.json(
      { success: false, error: '服务不可用' },
      { status: 503 }
    );
  }
}
