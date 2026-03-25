/**
 * Chat API - AI 对话接口
 * POST /api/chat - 发送消息获取AI回复
 */
import { NextRequest, NextResponse } from 'next/server';

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'sk-cp-HVHq56Z8XxY50HLWX3jhYoXFbXT7SNGFzDeOgssECOjhJaUf_D6ZpLigReVSJkRd-RQ7R7si1_VNC_c89uqz4VIJ0LCFZmzSCiSrEQFGKfLD6Hm5Fha3gA0';

// 获取实时市场数据
async function getMarketData(symbol: string = 'BTC', interval: string = '15m'): Promise<string> {
  try {
    // 获取当前价格
    const priceRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
    const priceData = await priceRes.json();
    const currentPrice = priceData.price || '未知';

    // 获取最近K线
    const klineRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=10`);
    const klines = await klineRes.json();

    // 解析最近K线
    interface KLine {
      time: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }
    const recentKlines: KLine[] = klines.slice(-5).map((k: [number, string, string, string, string, string, number]) => ({
      time: new Date(k[0]).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      open: parseFloat(k[1]).toFixed(2),
      high: parseFloat(k[2]).toFixed(2),
      low: parseFloat(k[3]).toFixed(2),
      close: parseFloat(k[4]).toFixed(2),
      volume: parseFloat(k[5]).toFixed(0),
    }));

    return `\n\n【实时行情】\n当前 BTC 价格: $${currentPrice}\n\n最近5根K线 (${interval}):\n${recentKlines.map(k => `${k.time} | 收:${k.close} 高:${k.high} 低:${k.low} 量:${k.volume}`).join('\n')}\n\n---\n以上是当前实时数据，回答时可以参考。`;
  } catch (e) {
    return '';
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, symbol = 'BTC' } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Invalid messages' }, { status: 400 });
    }

    // 获取实时市场数据
    const marketData = await getMarketData(symbol);

    // 构建与 MiniMax M2.7 的对话
    const systemPrompt = `你是一个专业的加密货币交易分析师，专注于 BTC 技术分析。使用ICT方法分析市场结构、FVG、Order Block、流动性等。` + (marketData ? '以下是你可以参考的实时行情数据：' + marketData + '\n回答时请结合实时数据分析。' : '注意：若无实时数据，请基于知识分析，但建议用户获取最新数据。');

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m: { role: string; content: string }) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const response = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': MINIMAX_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.7',
        messages: formattedMessages,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Chat API] MiniMax error:', error);
      return NextResponse.json({ error: 'AI服务请求失败' }, { status: 500 });
    }

    const result = await response.json();

    // MiniMax M2.7 返回格式: content 数组中 type="text" 的是回复
    const textContent = result.content?.find((c: { type: string; text?: string }) => c.type === 'text');
    const text = textContent?.text || '抱歉，无法生成回复';

    return NextResponse.json({
      success: true,
      content: text,
    });
  } catch (error) {
    console.error('[Chat API] Error:', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
