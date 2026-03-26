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
    priceLow: number;
    priceHigh: number;
    fillPercent: number;
    age: string;
    nearest: boolean;
  }>;
}> {
  const intervals = ['5m', '15m', '1h', '4h', '1d'];
  const { candles: currentCandles, currentPrice } = await getCandles(symbol, '1m');
  const opportunities: Array<{
    interval: string;
    direction: 'bull' | 'bear';
    priceRange: string;
    priceLow: number;
    priceHigh: number;
    fillPercent: number;
    age: string;
    nearest: boolean;
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
          priceLow: lastBull.low,
          priceHigh: lastBull.high,
          fillPercent: lastBull.fillPercent,
          age: lastBull.time,
          nearest: false,
        });
      }
      if (lastBear) {
        opportunities.push({
          interval,
          direction: 'bear',
          priceRange: `$${lastBear.low.toFixed(2)}-${lastBear.high.toFixed(2)}`,
          priceLow: lastBear.low,
          priceHigh: lastBear.high,
          fillPercent: lastBear.fillPercent,
          age: lastBear.time,
          nearest: false,
        });
      }
    } catch (e) {
      // 忽略错误继续下一个周期
    }
  }

  // 计算哪个FVG离当前价格最近
  let nearestIdx = -1;
  let nearestDist = Infinity;
  opportunities.forEach((opp, idx) => {
    // 计算FVG中点与当前价格的距离
    const midPrice = (opp.priceLow + opp.priceHigh) / 2;
    const dist = Math.abs(midPrice - currentPrice);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIdx = idx;
    }
  });
  if (nearestIdx >= 0) {
    opportunities[nearestIdx].nearest = true;
  }

  return { intervals, currentPrice, opportunities };
}

// FVG机会类型
interface FVGOpportunity {
  interval: string;
  direction: 'bull' | 'bear';
  priceRange: string;
  priceLow: number;
  priceHigh: number;
  fillPercent: number;
  age: string;
  nearest: boolean;
}

// 格式化 FVG25 数据
function formatFVG25Data(data: { intervals: string[]; currentPrice: number; opportunities: FVGOpportunity[] }): string {
  const { currentPrice, opportunities } = data;

  let msg = `【FVG 填补<25% 机会分析】\n`;
  msg += `当前价格: $${currentPrice.toFixed(2)}\n\n`;

  // 按周期分组
  const byInterval: Record<string, FVGOpportunity[]> = {};
  for (const opp of opportunities) {
    if (!byInterval[opp.interval]) byInterval[opp.interval] = [];
    byInterval[opp.interval].push(opp);
  }

  for (const [interval, opps] of Object.entries(byInterval)) {
    for (const opp of opps.slice(-2)) {
      // 最近的那个显示不同颜色
      const circle = opp.nearest
        ? (opp.direction === 'bull' ? '🔵' : '🟠')
        : (opp.direction === 'bull' ? '🟢' : '🔴');
      const paddedInterval = interval.padEnd(3);
      const marker = opp.nearest ? '*' : '';
      msg += `${paddedInterval} ${circle} ${opp.direction === 'bull' ? '多' : '空'} ${opp.priceRange} (${opp.fillPercent.toFixed(0)}%已填补)${marker}\n`;
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

      // 让 AI 分析 FVG 数据
      const systemPrompt = `你是ICT（Inner Circle Trader）方法论的专业分析师，专注于FVG分析。

## FVG 核心概念
- FVG 是价格快速移动留下的真空区
- 填补<25%的FVG表示接近填补完毕，可能是高概率的回调目标
- 看涨FVG（🟢/🔵）：价格向下快速移动后留下的向上跳空区域
- 看跌FVG（🔴/🟠）：价格向上快速移动后留下的向下跳空区域
- 🔵/🟠 表示离当前价格最近的FVG

## 数据已提供
下方提供了 BTC 各周期的 FVG 数据，包含多空方向、价格区间和填补百分比。

## 分析要求
简洁输出（2-3句）：
1. 当前价格处于什么位置（discount/premium）
2. 最近的FVG机会及方向判断
3. 短期操作建议

用专业但易懂的语言。`;

      try {
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
              { role: 'user', content: `分析以下 FVG 数据：\n\n${fvg25Msg}` },
            ],
            system: systemPrompt,
            max_tokens: 1500,
          }),
        });

        let aiAnalysis = '';
        if (response.ok) {
          const result = await response.json();
          const textContent = result.content?.find((c: { type: string; text?: string }) => c.type === 'text');
          aiAnalysis = textContent?.text || '';
        }

        const separator = '\n═══════════════════════════════════\n';
        const fullAnalysis = fvg25Msg + separator + aiAnalysis;

        return NextResponse.json({
          success: true,
          analysis: fullAnalysis,
          fvgData: fvg25Data,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        // AI 分析失败时只返回 FVG 列表
        return NextResponse.json({
          success: true,
          analysis: fvg25Msg,
          fvgData: fvg25Data,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('[Agent API] Error:', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
