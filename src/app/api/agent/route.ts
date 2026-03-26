/**
 * Agent API - 自主代理接口
 * POST /api/agent - 触发一次分析
 * GET /api/agent - 获取状态
 */
import { NextRequest, NextResponse } from 'next/server';

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'sk-cp-HVHq56Z8XxY50HLWX3jhYoXFbXT7SNGFzDeOgssECOjhJaUf_D6ZpLigReVSJkRd-RQ7R7si1_VNC_c89uqz4VIJ0LCFZmzSCiSrEQFGKfLD6Hm5Fha3gA0';
const DINGTALK_WEBHOOK = process.env.DINGTALK_WEBHOOK || '';

// 导入指标库
import {
  detectFVGs,
  Candle,
} from '@/lib/indicators/skillIndicators';

export async function GET() {
  return NextResponse.json({
    success: true,
    status: 'ok',
    message: 'Agent API is running',
  });
}

// K线数据
interface KLine {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

// 获取 K 线数据
async function getCandles(symbol: string, interval: string): Promise<{ candles: Candle[]; currentPrice: number }> {
  const klineRes = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=200`
  );
  const klinesRaw = await klineRes.json();

  const candles: Candle[] = klinesRaw.map((k: [number, string, string, string, string, string, number]) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));

  const currentPrice = candles[candles.length - 1].close;

  return { candles, currentPrice };
}

// 多周期 FVG25 分析
async function getMultiTimeframeFVG25(symbol: string): Promise<{
  intervals: string[];
  currentPrice: number;
  opportunities: Array<{
    interval: string;
    direction: 'bull' | 'bear';
    priceRange: string;
    fillPercent: number;
    age: string;
  }>;
}> {
  const intervals = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const { currentPrice } = await getCandles(symbol, '1m');
  const opportunities: Array<{
    interval: string;
    direction: 'bull' | 'bear';
    priceRange: string;
    fillPercent: number;
    age: string;
  }> = [];

  for (const interval of intervals) {
    try {
      const { candles } = await getCandles(symbol, interval);
      const fvgs = detectFVGs(candles);

      // 找填补小于25%的FVG（接近填补完毕）
      const openBull = fvgs.filter(f => f.direction === 'bull' && f.fillPercent < 25);
      const openBear = fvgs.filter(f => f.direction === 'bear' && f.fillPercent < 25);

      // 每个周期只取最新的看涨和看跌各一个
      const lastBull = openBull[openBull.length - 1];
      const lastBear = openBear[openBear.length - 1];

      if (lastBull) {
        opportunities.push({
          interval,
          direction: 'bull',
          priceRange: `$${lastBull.low.toFixed(2)}-${lastBull.high.toFixed(2)}`,
          fillPercent: lastBull.fillPercent,
          age: lastBull.time,
        });
      }
      if (lastBear) {
        opportunities.push({
          interval,
          direction: 'bear',
          priceRange: `$${lastBear.low.toFixed(2)}-${lastBear.high.toFixed(2)}`,
          fillPercent: lastBear.fillPercent,
          age: lastBear.time,
        });
      }
    } catch (e) {
      // 忽略错误继续下一个周期
    }
  }

  return { intervals, currentPrice, opportunities };
}

// 格式化 FVG25 数据
function formatFVG25Data(data: { intervals: string[]; currentPrice: number; opportunities: Array<{ interval: string; direction: 'bull' | 'bear'; priceRange: string; fillPercent: number; age: string }> }): string {
  const { currentPrice, opportunities } = data;

  let msg = `【FVG 填补<25% 机会分析】
当前价格: $${currentPrice.toFixed(2)}

`;

  // 按周期分组
  const byInterval: Record<string, typeof opportunities> = {};
  for (const opp of opportunities) {
    if (!byInterval[opp.interval]) byInterval[opp.interval] = [];
    byInterval[opp.interval].push(opp);
  }

  for (const [interval, opps] of Object.entries(byInterval)) {
    msg += `【${interval}】\n`;
    for (const opp of opps.slice(-2)) {
      const emoji = opp.direction === 'bull' ? '📈' : '📉';
      const type = opp.direction === 'bull' ? '看涨' : '看跌';
      msg += `  ${emoji} ${type} FVG: ${opp.priceRange} (填补${opp.fillPercent.toFixed(0)}%)\n`;
    }
  }

  if (opportunities.length === 0) {
    msg += `各周期暂无填补<25%的FVG机会\n`;
  }

  return msg;
}

// POST 处理
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, symbol = 'BTC', interval = '15m', dingtalk = true } = body;

    if (action === 'analyze') {
      // 获取多周期 FVG25 数据
      const fvg25Data = await getMultiTimeframeFVG25(symbol);
      const fvg25Msg = formatFVG25Data(fvg25Data);

      const systemPrompt = `你是ICT（Inner Circle Trader）方法论的专业分析师，专注于寻找FVG（Fair Value Gap）填补<25%的交易机会。

## FVG 核心概念
- FVG 是价格快速移动留下的真空区
- 填补<25%的FVG表示接近填补完毕，可能是高概率的回调目标
- 看涨FVG：价格向下快速移动后留下的向上跳空区域
- 看跌FVG：价格向上快速移动后留下的向下跳空区域

## 数据已提供
下方提供了 BTC 各周期（1m/5m/15m/1h/4h/1d）的 FVG 数据。
你只需要基于这些数据进行分析，不需要也不应该说自己无法获取数据。

## 分析要求
简洁输出（3-5句）：
1. 当前价格位置
2. 最有价值的FVG机会（哪个周期、什么方向、价格区间）
3. 短期方向判断

用专业但易懂的语言。`;

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
            { role: 'user', content: `分析 BTC FVG 填补<25% 机会。\n\n${fvg25Msg}` },
          ],
          system: systemPrompt,
          max_tokens: 2000,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[Agent API] MiniMax error:', error);
        return NextResponse.json({ error: 'AI服务请求失败' }, { status: 500 });
      }

      const result = await response.json();
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
                content: `【BTC FVG25 分析】\n${analysis}`,
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
        fvgData: fvg25Data,
        timestamp: new Date().toISOString(),
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('[Agent API] Error:', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
