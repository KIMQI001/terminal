import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, extractTokenFromHeader } from '@/lib/auth';
import { getDecryptedApiConfig } from '@/lib/apiConfig';
import crypto from 'crypto';

// 验证用户身份
async function authenticateUser(request: NextRequest): Promise<{ userId: number; username: string } | null> {
  const authHeader = request.headers.get('Authorization');
  const token = extractTokenFromHeader(authHeader);
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return null;
  return { userId: payload.userId, username: payload.username };
}

function sign(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

function getPrecision(symbol: string): { quantity: number; price: number } {
  const map: Record<string, { quantity: number; price: number }> = {
    'BTCUSDT': { quantity: 3, price: 1 },
    'ETHUSDT': { quantity: 3, price: 2 },
    'SOLUSDT': { quantity: 1, price: 2 },
    'BTCUSDC': { quantity: 3, price: 1 },
    'ETHUSDC': { quantity: 3, price: 2 },
  };
  return map[symbol] || { quantity: 3, price: 2 };
}

interface BinanceAlgoOrder {
  algoId: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET';
  triggerPrice?: string;
  stopPrice?: string;
  quantity: string;
  clientAlgoId?: string;
}

async function getOpenAlgoOrders(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string
): Promise<BinanceAlgoOrder[]> {
  const baseUrl = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  const timestamp = Date.now();
  const qs = `symbol=${symbol}&timestamp=${timestamp}`;
  const sig = sign(qs, apiSecret);
  const url = `${baseUrl}/fapi/v1/openAlgoOrders?${qs}&signature=${sig}`;
  const res = await fetch(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  const data = await res.json();
  if (!res.ok) {
    console.warn('[positions/sl-tp] openAlgoOrders failed:', data.msg);
    return [];
  }
  return Array.isArray(data) ? data : (data.orders || []);
}

async function cancelAlgoOrder(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string,
  algoId: number
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  const timestamp = Date.now();
  const qs = `symbol=${symbol}&algoId=${algoId}&timestamp=${timestamp}`;
  const sig = sign(qs, apiSecret);
  const url = `${baseUrl}/fapi/v1/algoOrder?${qs}&signature=${sig}`;
  try {
    const res = await fetch(url, { method: 'DELETE', headers: { 'X-MBX-APIKEY': apiKey } });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.msg || '取消失败' };
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '取消失败' };
  }
}

async function placeAlgoOrder(
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    positionSide: 'LONG' | 'SHORT';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity: number;
    triggerPrice: number;
    clientAlgoId?: string;
  }
): Promise<{ success: boolean; data?: { orderId: number; clientAlgoId?: string }; error?: string }> {
  const baseUrl = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  const precision = getPrecision(params.symbol);
  const timestamp = Date.now();
  const queryParams: Record<string, string | number> = {
    algoType: 'CONDITIONAL',
    symbol: params.symbol,
    side: params.side,
    positionSide: params.positionSide,
    type: params.type,
    quantity: params.quantity.toFixed(precision.quantity),
    triggerPrice: params.triggerPrice.toFixed(precision.price),
    timestamp,
  };
  if (params.clientAlgoId) queryParams.clientAlgoId = params.clientAlgoId;
  const qs = Object.entries(queryParams).map(([k, v]) => `${k}=${v}`).join('&');
  const sig = sign(qs, apiSecret);
  try {
    const res = await fetch(`${baseUrl}/fapi/v1/algoOrder`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${qs}&signature=${sig}`,
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.msg || '下单失败' };
    return { success: true, data: { orderId: data.orderId, clientAlgoId: data.clientAlgoId } };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '下单失败' };
  }
}

// 默认 SL/TP 偏移（相对入场价）
const DEFAULT_SL_OFFSET = 200;
const DEFAULT_TP_OFFSET = 1000;

function readAlgoPrice(o: BinanceAlgoOrder | undefined): number {
  if (!o) return 0;
  return parseFloat(o.triggerPrice || o.stopPrice || '0');
}

// POST /api/user/positions/sl-tp
// 修改持仓的止盈/止损
// body: { symbol, positionSide: 'LONG'|'SHORT', stopLoss?, takeProfit? }
//   stopLoss / takeProfit 留空或不传 = 该侧不修改（保留旧单；旧单没有则按 entry ± 偏移默认）
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) return NextResponse.json({ error: '未授权' }, { status: 401 });

  try {
    const body = await request.json();
    const { symbol, positionSide, stopLoss, takeProfit } = body;
    if (!symbol || !positionSide) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }
    if (positionSide !== 'LONG' && positionSide !== 'SHORT') {
      return NextResponse.json({ error: 'positionSide 必须为 LONG 或 SHORT' }, { status: 400 });
    }

    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    const baseUrl = config.isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

    // 1. 查持仓：拿 entryPrice 和 quantity（默认 SL/TP 需要 entryPrice）
    const ts1 = Date.now();
    const posQs = `symbol=${symbol}&timestamp=${ts1}`;
    const posSig = sign(posQs, config.apiSecret);
    const posRes = await fetch(`${baseUrl}/fapi/v2/positionRisk?${posQs}&signature=${posSig}`, {
      headers: { 'X-MBX-APIKEY': config.apiKey },
    });
    const posData = await posRes.json();
    const targetPos = (Array.isArray(posData) ? posData : []).find(
      (p: { symbol: string; positionSide: string; positionAmt: string; entryPrice: string }) =>
        p.symbol === symbol && p.positionSide === positionSide
    );
    if (!targetPos || parseFloat(targetPos.positionAmt) === 0) {
      return NextResponse.json({ success: false, error: '未找到持仓或数量为 0' }, { status: 400 });
    }
    const entryPrice = parseFloat(targetPos.entryPrice);
    const quantity = Math.abs(parseFloat(targetPos.positionAmt));

    // 2. 查该持仓现有的 Algo 条件单
    const algoOrders = await getOpenAlgoOrders(config.apiKey, config.apiSecret, config.isTestnet, symbol);
    const relatedOrders = algoOrders.filter((o) => o.positionSide === positionSide);
    const existingSL = relatedOrders.find((o) => o.type === 'STOP_MARKET');
    const existingTP = relatedOrders.find((o) => o.type === 'TAKE_PROFIT_MARKET');

    // 3. 决定最终 SL/TP：用户输入 > 保留旧单 > 默认（entry ± 偏移）
    const slProvided = typeof stopLoss === 'number' && stopLoss > 0;
    const tpProvided = typeof takeProfit === 'number' && takeProfit > 0;

    const finalSL = slProvided
      ? stopLoss
      : existingSL
        ? readAlgoPrice(existingSL)
        : (positionSide === 'LONG' ? entryPrice - DEFAULT_SL_OFFSET : entryPrice + DEFAULT_SL_OFFSET);

    const finalTP = tpProvided
      ? takeProfit
      : existingTP
        ? readAlgoPrice(existingTP)
        : (positionSide === 'LONG' ? entryPrice + DEFAULT_TP_OFFSET : entryPrice - DEFAULT_TP_OFFSET);

    // 4. 取消现有的所有 Algo 条件单
    const cancelResults = await Promise.allSettled(
      relatedOrders.map((o) =>
        cancelAlgoOrder(config.apiKey, config.apiSecret, config.isTestnet, symbol, o.algoId)
      )
    );
    const cancelledCount = cancelResults.filter((r) => r.status === 'fulfilled' && r.value.success).length;
    console.log(`[positions/sl-tp] 取消了 ${cancelledCount}/${relatedOrders.length} 个旧 Algo 单`);

    // 5. 平仓方向（与持仓方向相反）
    const closeSide: 'BUY' | 'SELL' = positionSide === 'LONG' ? 'SELL' : 'BUY';

    // 6. 挂新单
    const results: { stopLoss?: { success: boolean; orderId?: number; error?: string }; takeProfit?: { success: boolean; orderId?: number; error?: string } } = {};
    const warnings: string[] = [];
    const prefix = `manual_${Date.now()}`;

    if (finalSL > 0) {
      const slRes = await placeAlgoOrder(config.apiKey, config.apiSecret, config.isTestnet, {
        symbol,
        side: closeSide,
        positionSide,
        type: 'STOP_MARKET',
        quantity,
        triggerPrice: finalSL,
        clientAlgoId: `${prefix}_sl`,
      });
      results.stopLoss = slRes;
      if (!slRes.success) warnings.push(`止损单失败: ${slRes.error}`);
    }

    if (finalTP > 0) {
      const tpRes = await placeAlgoOrder(config.apiKey, config.apiSecret, config.isTestnet, {
        symbol,
        side: closeSide,
        positionSide,
        type: 'TAKE_PROFIT_MARKET',
        quantity,
        triggerPrice: finalTP,
        clientAlgoId: `${prefix}_tp`,
      });
      results.takeProfit = tpRes;
      if (!tpRes.success) warnings.push(`止盈单失败: ${tpRes.error}`);
    }

    return NextResponse.json({
      success: true,
      cancelledOld: cancelledCount,
      finalStopLoss: finalSL > 0 ? finalSL : undefined,
      finalTakeProfit: finalTP > 0 ? finalTP : undefined,
      results,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (error) {
    console.error('Update SL/TP error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '更新止盈止损失败',
    }, { status: 500 });
  }
}
