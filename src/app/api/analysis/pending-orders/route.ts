/**
 * 待处理订单 API
 * 用于存储守塔订单的止盈止损信息，供 analysis-service 成交后下单
 */

import { NextRequest, NextResponse } from 'next/server';

// analysis-service 地址
const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || 'http://localhost:3002';

// POST: 添加待处理订单
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // 转发到 analysis-service
    const response = await fetch(`${ANALYSIS_SERVICE_URL}/api/pending-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[pending-orders] POST error:', error);
    return NextResponse.json(
      { success: false, error: '服务不可用' },
      { status: 503 }
    );
  }
}

// GET: 获取待处理订单
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const clientOrderId = searchParams.get('clientOrderId');

    let url = `${ANALYSIS_SERVICE_URL}/api/pending-orders`;
    if (clientOrderId) {
      url += `?clientOrderId=${clientOrderId}`;
    }

    const response = await fetch(url);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[pending-orders] GET error:', error);
    return NextResponse.json(
      { success: false, error: '服务不可用' },
      { status: 503 }
    );
  }
}

// DELETE: 删除待处理订单
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const clientOrderId = searchParams.get('clientOrderId');

    if (!clientOrderId) {
      return NextResponse.json(
        { success: false, error: '缺少 clientOrderId' },
        { status: 400 }
      );
    }

    const response = await fetch(
      `${ANALYSIS_SERVICE_URL}/api/pending-orders?clientOrderId=${clientOrderId}`,
      { method: 'DELETE' }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[pending-orders] DELETE error:', error);
    return NextResponse.json(
      { success: false, error: '服务不可用' },
      { status: 503 }
    );
  }
}
