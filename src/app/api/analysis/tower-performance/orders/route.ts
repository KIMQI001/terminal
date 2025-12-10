import { NextRequest, NextResponse } from "next/server";

export const dynamic = 'force-dynamic';

const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || "http://localhost:3002";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const queryString = searchParams.toString();

    let url = `${ANALYSIS_SERVICE_URL}/api/tower-performance/orders`;
    if (queryString) {
      url += `?${queryString}`;
    }

    const response = await fetch(url, { cache: 'no-store' });
    const data = await response.json();

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (error) {
    console.error("[API] tower-performance/orders error:", error);
    return NextResponse.json(
      { success: false, error: "服务暂不可用" },
      { status: 503 }
    );
  }
}
