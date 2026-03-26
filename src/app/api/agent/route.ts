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

  let msg = `【FVG 填补<25% 机会分析】\n`;
  msg += `当前价格: $${currentPrice.toFixed(2)}\n\n`;

  // 按周期分组
  const byInterval: Record<string, typeof opportunities> = {};
  for (const opp of opportunities) {
    if (!byInterval[opp.interval]) byInterval[opp.interval] = [];
    byInterval[opp.interval].push(opp);
  }

  for (const [interval, opps] of Object.entries(byInterval)) {
    msg += `【${interval}】\n`;
    for (const opp of opps.slice(-2)) {
      const circle = opp.direction === 'bull' ? '🟢' : '🔴';
      msg += `${circle} ${opp.direction === 'bull' ? '多' : '空'}: ${opp.priceRange} (${opp.fillPercent.toFixed(0)}%已填补)\n`;
    }
    msg += `\n`;
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

      // 直接返回格式化列表，不经过 AI
      return NextResponse.json({
        success: true,
        analysis: fvg25Msg,
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
