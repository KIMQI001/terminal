import { NextRequest, NextResponse } from "next/server";

const COINGLASS_SERVICE_URL =
  process.env.COINGLASS_SERVICE_URL || "http://127.0.0.1:3004";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol") || "BTC";
  const limit = searchParams.get("limit") || "5";

  try {
    const res = await fetch(
      `${COINGLASS_SERVICE_URL}/api/liqmap/top?symbol=${symbol}&limit=${limit}`,
      { next: { revalidate: 60 } }
    );

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: "Coinglass service error" },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: "Coinglass service unavailable" },
      { status: 503 }
    );
  }
}
