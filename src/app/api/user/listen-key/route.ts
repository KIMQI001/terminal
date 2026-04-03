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

// 获取 Binance API 基础 URL
function getBinanceBaseUrl(isTestnet: boolean): string {
  return isTestnet
    ? 'https://testnet.binancefuture.com'
    : 'https://fapi.binance.com';
}

// 生成 Binance API 签名
function generateBinanceSignature(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

// POST /api/user/listen-key - 创建 listenKey
export async function POST(request: NextRequest) {
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

    const baseUrl = getBinanceBaseUrl(config.isTestnet);
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = generateBinanceSignature(queryString, config.apiSecret);

    const url = `${baseUrl}/fapi/v1/listenKey?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[listen-key] 创建 listenKey 失败:', data);
      return NextResponse.json({
        success: false,
        error: data.msg || '创建 listenKey 失败',
      }, { status: response.status });
    }

    console.log('[listen-key] 创建 listenKey 成功');
    return NextResponse.json({
      success: true,
      listenKey: data.listenKey,
    });
  } catch (error) {
    console.error('[listen-key] 创建 listenKey 异常:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '创建 listenKey 失败',
    }, { status: 500 });
  }
}

// PUT /api/user/listen-key - 延长 listenKey 有效期
export async function PUT(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { listenKey } = body;

    if (!listenKey) {
      return NextResponse.json({ error: '缺少 listenKey' }, { status: 400 });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    const baseUrl = getBinanceBaseUrl(config.isTestnet);
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = generateBinanceSignature(queryString, config.apiSecret);

    const url = `${baseUrl}/fapi/v1/listenKey?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
      },
    });

    if (!response.ok) {
      const data = await response.json();
      console.error('[listen-key] 延长 listenKey 失败:', data);
      return NextResponse.json({
        success: false,
        error: data.msg || '延长 listenKey 失败',
      }, { status: response.status });
    }

    console.log('[listen-key] 延长 listenKey 成功');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[listen-key] 延长 listenKey 异常:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '延长 listenKey 失败',
    }, { status: 500 });
  }
}

// DELETE /api/user/listen-key - 关闭 listenKey
export async function DELETE(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { listenKey } = body;

    if (!listenKey) {
      // listenKey 不存在也返回成功
      return NextResponse.json({ success: true });
    }

    // 获取解密后的 API 配置
    const config = await getDecryptedApiConfig(user.userId, 'binance');
    if (!config) {
      return NextResponse.json({ error: '未找到 Binance API 配置' }, { status: 404 });
    }

    const baseUrl = getBinanceBaseUrl(config.isTestnet);
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = generateBinanceSignature(queryString, config.apiSecret);

    const url = `${baseUrl}/fapi/v1/listenKey?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'X-MBX-APIKEY': config.apiKey,
      },
    });

    if (!response.ok) {
      const data = await response.json();
      console.error('[listen-key] 关闭 listenKey 失败:', data);
      // 即使失败也返回成功，因为可能是已经过期了
    } else {
      console.log('[listen-key] 关闭 listenKey 成功');
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[listen-key] 关闭 listenKey 异常:', error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : '关闭 listenKey 失败',
    }, { status: 500 });
  }
}
