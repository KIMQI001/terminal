/**
 * look-left-right 服务代理路由
 * 将 /api/look-left-right/* 请求代理到 Rust 服务(默认 127.0.0.1:3005)
 *
 * - /config  : 前端只传业务参数,服务端在这里解密用户的交易所 API 密钥后注入,再转发
 * - /status  : 查询策略状态
 * - /frame   : 只算框架(与「最长波段」面板对齐),不需要密钥
 * - /stop    : 停止策略
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyToken, extractTokenFromHeader } from "@/lib/auth";
import { getDecryptedApiConfig } from "@/lib/apiConfig";

const LLR_API = process.env.LOOK_LEFT_RIGHT_API || "http://127.0.0.1:3005";

/** 从 Authorization 头里解出 userId */
async function getUserId(request: NextRequest): Promise<number | null> {
  const token = extractTokenFromHeader(request.headers.get("Authorization"));
  if (!token) return null;
  const payload = await verifyToken(token);
  return payload?.userId ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    const path = params.path.join("/");
    const userId = await getUserId(request);
    if (!userId) {
      return NextResponse.json({ success: false, error: "未登录" }, { status: 401 });
    }
    const searchParams = request.nextUrl.searchParams.toString();
    const url = `${LLR_API}/${path}${searchParams ? `?${searchParams}` : ""}`;

    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[look-left-right] GET error:", error);
    return NextResponse.json(
      { success: false, error: "look-left-right 服务不可用" },
      { status: 503 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    const path = params.path.join("/");
    const url = `${LLR_API}/${path}`;

    if (path === "config") {
      const userId = await getUserId(request);
      if (!userId) {
        return NextResponse.json(
          { success: false, error: "未登录" },
          { status: 401 }
        );
      }
      const body = await request.json();
      const exchange: string = body.exchange || "binance";
      const apiConfig = await getDecryptedApiConfig(userId, exchange);
      if (!apiConfig) {
        return NextResponse.json(
          { success: false, error: `没有找到 ${exchange} 的 API 配置` },
          { status: 400 }
        );
      }

      const payload = {
        user_id: userId,
        symbol: String(body.symbol || "BTCUSDC").toUpperCase(),
        exchange,
        timeframe: String(body.timeframe || "15m"),
        api_key: apiConfig.apiKey,
        api_secret: apiConfig.apiSecret,
        is_testnet: !!apiConfig.isTestnet,
        margin_pct: body.margin_pct ?? 0.375,
        sl_points: body.sl_points ?? 200,
        tp_points: body.tp_points ?? 1000,
        leverage: body.leverage ?? 20,
        poll_interval_sec: body.poll_interval_sec ?? 5,
        dry_run: body.dry_run !== false,
      };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      return NextResponse.json(data, { status: response.status });
    }

    // 其余 POST(stop 等)直接透传
    const raw = await request.text();
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw || "{}",
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[look-left-right] POST error:", error);
    return NextResponse.json(
      { success: false, error: "look-left-right 服务不可用" },
      { status: 503 }
    );
  }
}
