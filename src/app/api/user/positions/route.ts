import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, extractTokenFromHeader } from '@/lib/auth';
import { getDecryptedApiConfig } from '@/lib/apiConfig';
import crypto from 'crypto';

// 验证用户身份
async function authenticateUser(request: NextRequest): Promise<{ userId: number; username: string } | null> {
  const authHeader = request.headers.get('Authorization');
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    return null;
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return null;
  }

  return { userId: payload.userId, username: payload.username };
}

// 生成 Binance API 签名
function generateBinanceSignature(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// 获取持仓
async function getBinancePositions(apiKey: string, apiSecret: string, isTestnet: boolean) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = generateBinanceSignature(queryString, apiSecret);

  const url = `${baseUrl}/fapi/v2/positionRisk?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.msg || '获取持仓失败');
  }

  return data;
}

// GET /api/user/positions - 获取持仓列表
export async function GET(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    const positions = await getBinancePositions(config.apiKey, config.apiSecret, config.isTestnet);

    // 过滤出有持仓的（positionAmt != 0）
    const activePositions = positions
      .filter((p: { positionAmt: string }) => parseFloat(p.positionAmt) !== 0)
      .map((p: {
        symbol: string;
        positionSide: string;
        positionAmt: string;
        entryPrice: string;
        markPrice: string;
        unRealizedProfit: string;
        leverage: string;
        liquidationPrice: string;
      }) => ({
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? 'long' : 'short',
        positionSide: p.positionSide,
        quantity: Math.abs(parseFloat(p.positionAmt)),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        unrealizedPnl: parseFloat(p.unRealizedProfit),
        leverage: parseInt(p.leverage),
        liquidationPrice: parseFloat(p.liquidationPrice),
      }));

    return NextResponse.json({ success: true, positions: activePositions });
  } catch (error) {
    console.error('Get positions error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '获取持仓失败',
    }, { status: 500 });
  }
}
