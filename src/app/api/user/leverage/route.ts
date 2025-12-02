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

// 获取当前杠杆
async function getBinanceLeverage(apiKey: string, apiSecret: string, isTestnet: boolean, symbol: string) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = generateBinanceSignature(queryString, apiSecret);

  // 获取持仓信息（包含杠杆）
  const url = `${baseUrl}/fapi/v2/positionRisk?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.msg || '获取杠杆失败');
  }

  const data = await response.json();

  // 找到指定交易对的杠杆
  const position = data.find((p: { symbol: string }) => p.symbol === symbol);

  return {
    success: true,
    leverage: position ? parseInt(position.leverage) : 20, // 默认 20 倍
    symbol,
  };
}

// 设置杠杆
async function setBinanceLeverage(apiKey: string, apiSecret: string, isTestnet: boolean, symbol: string, leverage: number) {
  const baseUrl = isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';

  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`;
  const signature = generateBinanceSignature(queryString, apiSecret);

  const url = `${baseUrl}/fapi/v1/leverage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `${queryString}&signature=${signature}`,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.msg || '设置杠杆失败');
  }

  const data = await response.json();

  return {
    success: true,
    leverage: data.leverage,
    symbol: data.symbol,
    maxNotionalValue: data.maxNotionalValue,
  };
}

// GET /api/user/leverage - 获取当前杠杆
export async function GET(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');

    if (!symbol) {
      return NextResponse.json({ error: '请指定交易对' }, { status: 400 });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    const result = await getBinanceLeverage(config.apiKey, config.apiSecret, config.isTestnet, symbol);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Get leverage error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '获取杠杆失败',
    }, { status: 500 });
  }
}

// POST /api/user/leverage - 设置杠杆
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const { symbol, leverage } = await request.json();

    if (!symbol) {
      return NextResponse.json({ error: '请指定交易对' }, { status: 400 });
    }

    if (!leverage || leverage < 1 || leverage > 125) {
      return NextResponse.json({ error: '杠杆倍数必须在 1-125 之间' }, { status: 400 });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    const result = await setBinanceLeverage(config.apiKey, config.apiSecret, config.isTestnet, symbol, leverage);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Set leverage error:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '设置杠杆失败',
    }, { status: 500 });
  }
}
