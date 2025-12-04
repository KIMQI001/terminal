/**
 * 守塔托管 API 代理
 * 转发请求到 analysis-service
 */

import { NextRequest, NextResponse } from 'next/server';

// analysis-service 地址
const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || 'http://127.0.0.1:3002';

// GET: 获取托管配置
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const symbol = searchParams.get('symbol');

    if (!userId || !symbol) {
      return NextResponse.json(
        { success: false, error: '缺少 userId 或 symbol 参数' },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${ANALYSIS_SERVICE_URL}/api/tower-management?userId=${userId}&symbol=${symbol}`
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[tower-management] GET error:', error);
    return NextResponse.json(
      { success: false, error: '服务不可用' },
      { status: 503 }
    );
  }
}

// POST: 更新托管配置
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const response = await fetch(`${ANALYSIS_SERVICE_URL}/api/tower-management`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[tower-management] POST error:', error);
    return NextResponse.json(
      { success: false, error: '服务不可用' },
      { status: 503 }
    );
  }
}
