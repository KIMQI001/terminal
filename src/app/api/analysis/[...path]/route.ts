/**
 * Analysis Service 代理路由
 * 将 /api/analysis/* 请求代理到 analysis-service (127.0.0.1:3002)
 */

import { NextRequest, NextResponse } from "next/server";

const ANALYSIS_API = process.env.ANALYSIS_API_INTERNAL || "http://127.0.0.1:3002";

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    const path = params.path.join("/");
    const searchParams = request.nextUrl.searchParams.toString();
    const url = `${ANALYSIS_API}/api/${path}${searchParams ? `?${searchParams}` : ""}`;

    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[Analysis Proxy] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to connect to analysis service",
      },
      { status: 502 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    const path = params.path.join("/");
    const url = `${ANALYSIS_API}/api/${path}`;
    const body = await request.json();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[Analysis Proxy] POST Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to connect to analysis service",
      },
      { status: 502 }
    );
  }
}
