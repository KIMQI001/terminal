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
  detectSwingPoints,
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

// 获取多周期 K 线数据 (1H + 15m)
async function getMultiTimeframeCandles(symbol: string): Promise<{
  candles1h: Candle[];
  candles15m: Candle[];
  currentPrice: number;
}> {
  const [res1h, res15m] = await Promise.all([
    fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&limit=200`),
    fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=15m&limit=200`),
  ]);

  const [raw1h, raw15m] = await Promise.all([res1h.json(), res15m.json()]);

  const candles1h: Candle[] = raw1h.map((k: [number, string, string, string, string, string, number]) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));

  const candles15m: Candle[] = raw15m.map((k: [number, string, string, string, string, string, number]) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));

  const currentPrice = candles15m[candles15m.length - 1].close;

  return { candles1h, candles15m, currentPrice };
}

// 分析单周期结构
interface StructureData {
  trend: 'bullish' | 'bearish' | 'neutral';
  hh: string;
  hl: string;
  lh: string;
  ll: string;
  position: string;
  nextTarget: string;
  support: string;
}

function analyzeStructure(candles: Candle[], currentPrice: number): StructureData {
  const swings = detectSwingPoints(candles, 5);
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'neutral', hh: '', hl: '', lh: '', ll: '', position: '数据不足', nextTarget: '', support: '' };
  }

  const recentHighs = highs.slice(-5);
  const recentLows = lows.slice(-5);

  let hh = '', hl = '', lh = '', ll = '';
  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';

  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price > recentHighs[i-1].price) {
      hh = `$${recentHighs[i].price.toFixed(2)}`;
    } else {
      lh = `$${recentHighs[i].price.toFixed(2)}`;
    }
  }

  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price > recentLows[i-1].price) {
      hl = `$${recentLows[i].price.toFixed(2)}`;
    } else {
      ll = `$${recentLows[i].price.toFixed(2)}`;
    }
  }

  if (hh && hl) {
    trend = 'bullish';
  } else if (lh && ll) {
    trend = 'bearish';
  }

  let position = '';
  let nextTarget = '';
  let support = '';

  if (trend === 'bullish') {
    if (currentPrice < parseFloat(hl)) {
      position = `回踩中`;
      support = hl;
      nextTarget = hh;
    } else if (currentPrice > parseFloat(hh)) {
      position = `突破HH(${hh})，多头延续`;
      support = hl;
      nextTarget = '新高';
    } else {
      position = `HH(${hh})与HL(${hl})之间`;
      support = hl;
      nextTarget = hh;
    }
  } else if (trend === 'bearish') {
    if (currentPrice > parseFloat(lh)) {
      position = `反弹中`;
      nextTarget = ll;
      support = lh;
    } else if (currentPrice < parseFloat(ll)) {
      position = `跌破LL(${ll})，空头延续`;
      nextTarget = '新低';
      support = lh;
    } else {
      position = `LH(${lh})与LL(${ll})之间`;
      nextTarget = ll;
      support = lh;
    }
  }

  return { trend, hh, hl, lh, ll, position, nextTarget, support };
}

// 格式化多周期结构分析
function formatStructureAnalysis(
  candles1h: Candle[],
  candles15m: Candle[],
  currentPrice: number
): string {
  const structure1h = analyzeStructure(candles1h, currentPrice);
  const structure15m = analyzeStructure(candles15m, currentPrice);

  // 综合分析
  let overallTrend = 'neutral';
  let analysis = '';

  if (structure1h.trend === 'bullish' && structure15m.trend === 'bullish') {
    overallTrend = '🟢 多头共振';
    analysis = `1H确认多头，15m回踩入场`;
  } else if (structure1h.trend === 'bearish' && structure15m.trend === 'bearish') {
    overallTrend = '🔴 空头共振';
    analysis = `1H确认空头，15m反弹做空`;
  } else if (structure1h.trend === 'bullish' && structure15m.trend === 'bearish') {
    overallTrend = '🟡 背离';
    analysis = `1H多头但15m空头，等待15m企稳`;
  } else if (structure1h.trend === 'bearish' && structure15m.trend === 'bullish') {
    overallTrend = '🟡 背离';
    analysis = `1H空头但15m多头，等待15m企稳`;
  } else {
    overallTrend = '⚪ 中性';
    analysis = `等待结构确认`;
  }

  return `【多周期结构分析】(1H + 15m)
当前价格: $${currentPrice.toFixed(2)}
综合判断: ${overallTrend} - ${analysis}

━━━ 1H 大周期 ━━━
趋势: ${structure1h.trend === 'bullish' ? '🟢 多头' : structure1h.trend === 'bearish' ? '🔴 空头' : '⚪ 中性'}
位置: ${structure1h.position}
HH: ${structure1h.hh || '无'} | HL: ${structure1h.hl || '无'} (支撑)
LH: ${structure1h.lh || '无'} (阻力) | LL: ${structure1h.ll || '无'}

━━━ 15m 小周期 ━━━
趋势: ${structure15m.trend === 'bullish' ? '🟢 多头' : structure15m.trend === 'bearish' ? '🔴 空头' : '⚪ 中性'}
位置: ${structure15m.position}
HH: ${structure15m.hh || '无'} | HL: ${structure15m.hl || '无'} (支撑)
LH: ${structure15m.lh || '无'} (阻力) | LL: ${structure15m.ll || '无'}

【关键决策】
方向: 1H ${structure1h.trend === 'bullish' ? '做多为主' : structure1h.trend === 'bearish' ? '做空为主' : '观望'}
入场: 15m回踩 ${structure15m.hl || structure1h.hl || '支撑位'} 可尝试做多
止损: 跌破 ${structure15m.ll || structure1h.ll || '前低'}`;
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

      // 获取多周期结构数据 (1H + 15m)
      const { candles1h, candles15m, currentPrice } = await getMultiTimeframeCandles(symbol);
      const structureMsg = formatStructureAnalysis(candles1h, candles15m, currentPrice);

      // 让 AI 分析 FVG + 结构数据
      const systemPrompt = `你是ICT（Inner Circle Trader）方法论的专业分析师，结合FVG和结构分析。

## FVG 核心概念
- FVG 是价格快速移动留下的真空区
- 填补<25%的FVG表示接近填补完毕，可能是高概率的回调目标
- 看涨FVG（🟢/🔵）：价格向下快速移动后留下的向上跳空区域
- 看跌FVG（🔴/🟠）：价格向上快速移动后留下的向下跳空区域
- 🔵/🟠 表示离当前价格最近的FVG

## 结构分析概念
- HH(更高高点)/HL(更高低点) = 多头结构
- LH(更低高点)/LL(更低低点) = 空头结构
- 多头趋势：价格回踩HL后上涨，突破HH确认
- 空头趋势：价格反弹LH后下跌，跌破LL确认
- 🟢 多头共振 = 1H和15m都确认多头
- 🔴 空头共振 = 1H和15m都确认空头
- 🟡 背离 = 周期方向矛盾

## 数据已提供
下方提供了：
1. BTC 各周期的 FVG 数据（填补<25%）
2. 1H + 15m 多周期结构分析

## 分析要求
简洁输出（2-3句）：
1. 当前价格处于什么位置（discount/premium）
2. 结合FVG和结构判断方向
3. 短期操作建议（结合入场点、止损点）

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
              { role: 'user', content: `分析以下数据：\n\n${fvg25Msg}\n\n${structureMsg}` },
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
        const fullAnalysis = fvg25Msg + '\n' + structureMsg + separator + aiAnalysis;

        return NextResponse.json({
          success: true,
          analysis: fullAnalysis,
          fvgData: fvg25Data,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        // AI 分析失败时只返回数据列表
        return NextResponse.json({
          success: true,
          analysis: fvg25Msg + '\n\n' + structureMsg,
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
