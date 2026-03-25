/**
 * Agent API - 自主代理接口
 * POST /api/agent - 触发一次分析
 * GET /api/agent - 获取状态
 */
import { NextRequest, NextResponse } from 'next/server';

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'sk-cp-HVHq56Z8XxY50HLWX3jhYoXFbXT7SNGFzDeOgssECOjhJaUf_D6ZpLigReVSJkRd-RQ7R7si1_VNC_c89uqz4VIJ0LCFZmzSCiSrEQFGKfLD6Hm5Fha3gA0';
const DINGTALK_WEBHOOK = process.env.DINGTALK_WEBHOOK || '';

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ok',
    message: 'Agent API is running',
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, symbol = 'BTC', interval = '15m', dingtalk = true } = body;

    if (action === 'analyze') {
      // 获取实时市场价格
      let marketData = '';
      try {
        // 获取当前价格
        const priceRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
        const priceData = await priceRes.json();
        const currentPrice = priceData.price || '未知';

        // 获取最近K线
        const klineRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=20`);
        const klines = await klineRes.json();

        // 解析最近20根K线
        interface KLine {
          time: string;
          open: string;
          high: string;
          low: string;
          close: string;
        }
        const recentKlines: KLine[] = klines.slice(-20).map((k: [number, string, string, string, string, string, number, number, number, number, number, number]) => ({
          time: new Date(k[0]).toLocaleString('zh-CN'),
          open: parseFloat(k[1]).toFixed(2),
          high: parseFloat(k[2]).toFixed(2),
          low: parseFloat(k[3]).toFixed(2),
          close: parseFloat(k[4]).toFixed(2),
        }));

        marketData = `\n\n【当前市场数据】\n当前价格: $${currentPrice}\n\n最近20根${interval} K线:\n${recentKlines.map((k: KLine) => `${k.time} | 开:${k.open} 高:${k.high} 低:${k.low} 收:${k.close}`).join('\n')}`;
      } catch (e) {
        marketData = '\n\n无法获取市场数据，请参考当前价格信息。';
      }

      // 构建 ICT 分析请求
      const systemPrompt = `你是专业的加密货币交易分析师，使用ICT方法分析BTC市场。

分析内容包括：
1. 当前价格位置（相对重要支撑阻力）
2. 市场结构（BOS/CHoCH）
3. 订单块（Order Block）
4. 公平价值gap（FVG）
5. 流动性区域
6. 关键价位

回复格式：简洁专业，3-5句话概括重点。`;

      const response = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': MINIMAX_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'MiniMax-M2.7',
          messages: [
            { role: 'user', content: `分析 BTC 当前行情，时间周期 ${interval}。${marketData}` },
          ],
          system: systemPrompt,
          max_tokens: 4000,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[Agent API] MiniMax error:', error);
        return NextResponse.json({ error: 'AI服务请求失败' }, { status: 500 });
      }

      const result = await response.json();
      // MiniMax M2.7 返回格式: content 数组中 type="text" 的是回复
      const textContent = result.content?.find((c: { type: string; text?: string }) => c.type === 'text');
      const analysis = textContent?.text || '无法生成分析';

      // 钉钉通知
      if (dingtalk && DINGTALK_WEBHOOK) {
        try {
          await fetch(DINGTALK_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              msgtype: 'text',
              text: {
                content: `【BTC 自动分析】\n${analysis}`,
              },
            }),
          });
        } catch (notifyError) {
          console.error('[Agent API] DingTalk notification failed:', notifyError);
        }
      }

      return NextResponse.json({
        success: true,
        analysis,
        timestamp: new Date().toISOString(),
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('[Agent API] Error:', error);
    return NextResponse.json({ error: '服务器错误' }, { status:  500 });
  }
}
