import { NextRequest, NextResponse } from "next/server";

const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || "http://localhost:3002";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const queryString = searchParams.toString();

    let url = `${ANALYSIS_SERVICE_URL}/api/tower-performance/stats`;
    if (queryString) {
      url += `?${queryString}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] tower-performance/stats error:", error);
    return NextResponse.json(
      { success: false, error: "服务暂不可用" },
      { status: 503 }
    );
  }
}
