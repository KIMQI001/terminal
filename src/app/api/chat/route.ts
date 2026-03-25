/**
 * Chat API - AI 对话接口
 * POST /api/chat - 发送消息获取AI回复
 */
import { NextRequest, NextResponse } from 'next/server';

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'sk-cp-HVHq56Z8XxY50HLWX3jhYoXFbXT7SNGFzDeOgssECOjhJaUf_D6ZpLigReVSJkRd-RQ7R7si1_VNC_c89uqz4VIJ0LCFZmzSCiSrEQFGKfLD6Hm5Fha3gA0';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, symbol = 'BTC' } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Invalid messages' }, { status: 400 });
    }

    // 构建与 MiniMax M2.7 的对话
    const systemPrompt = `你是一个专业的加密货币交易分析师，专注于 BTC 技术分析。使用ICT方法分析市场结构、FVG、Order Block、流动性等。回答简洁专业，最多3-5句话。`;

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
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Chat API] MiniMax error:', error);
      return NextResponse.json({ error: 'AI服务请求失败' }, { status: 500 });
    }

    const result = await response.json();

    // MiniMax M2.7 返回格式: content[0].thinking 或 content[0].text
    const text = result.content?.[0]?.thinking || result.content?.[0]?.text || '抱歉，无法生成回复';

    return NextResponse.json({
      success: true,
      content: text,
    });
  } catch (error) {
    console.error('[Chat API] Error:', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
