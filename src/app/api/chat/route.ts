/**
 * Chat API - AI 对话接口
 * POST /api/chat - 发送消息获取AI回复
 */
import { NextRequest, NextResponse } from 'next/server';

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'sk-cp-HVHq56Z8XxY50HLWX3jhYoXFbXT7SNGFzDeOgssECOjhJaUf_D6ZpLigReVSJkRd-RQ7R7si1_VNC_c89uqz4VIJ0LCFZmzSCiSrEQFGKfLD6Hm5Fha3gA0';

// K线数据
interface KLine {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ICT 概念检测
interface ICTData {
  swingHighs: { time: string; price: number }[];
  swingLows: { time: string; price: number }[];
  fvgBullish: { time: string; high: number; low: number }[];
  fvgBearish: { time: string; high: number; low: number }[];
  orderBlocks: { time: string; price: number; side: 'bull' | 'bear'; strength: number }[];
}

// 检测 Swing Points
function detectSwingPoints(klines: KLine[], lookback: number = 5): { highs: { time: string; price: number }[]; lows: { time: string; price: number }[] } {
  const highs: { time: string; price: number }[] = [];
  const lows: { time: string; price: number }[] = [];

  for (let i = lookback; i < klines.length - lookback; i++) {
    const isHigh = klines.slice(i - lookback, i + lookback + 1).every((k, idx) => idx === lookback || k.high <= klines[i].high);
    if (isHigh) highs.push({ time: klines[i].time, price: klines[i].high });

    const isLow = klines.slice(i - lookback, i + lookback + 1).every((k, idx) => idx === lookback || k.low >= klines[i].low);
    if (isLow) lows.push({ time: klines[i].time, price: klines[i].low });
  }

  return { highs, lows };
}

// 检测 FVG
function detectFVG(klines: KLine[]): { bullish: { time: string; high: number; low: number }[]; bearish: { time: string; high: number; low: number }[] } {
  const bullish: { time: string; high: number; low: number }[] = [];
  const bearish: { time: string; high: number; low: number }[] = [];

  for (let i = 2; i < klines.length; i++) {
    const prev = klines[i - 2];
    const curr = klines[i];
    const mid = klines[i - 1];

    if (prev.close > prev.open && curr.close < curr.open && mid.low > prev.high) {
      bullish.push({ time: mid.time, high: mid.high, low: mid.low });
    }

    if (prev.close < prev.open && curr.close > curr.open && mid.high < prev.low) {
      bearish.push({ time: mid.time, high: mid.high, low: mid.low });
    }
  }

  return { bullish, bearish };
}

// 检测 Order Block
function detectOrderBlocks(klines: KLine[]): { time: string; price: number; side: 'bull' | 'bear'; strength: number }[] {
  const blocks: { time: string; price: number; side: 'bull' | 'bear'; strength: number }[] = [];
  let consecutive = 1;

  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1];
    const curr = klines[i];
    const sameDirection = (curr.close > curr.open) === (prev.close > prev.open);

    if (sameDirection) {
      consecutive++;
    } else {
      if (consecutive >= 1) {
        const sumHigh = klines.slice(i - consecutive, i).reduce((s, k) => s + k.high, 0);
        const sumLow = klines.slice(i - consecutive, i).reduce((s, k) => s + k.low, 0);
        const avgPrice = (sumLow / consecutive + sumHigh / consecutive) / 2;

        blocks.push({
          time: klines[i - consecutive].time,
          price: parseFloat(avgPrice.toFixed(2)),
          side: prev.close > prev.open ? 'bull' : 'bear',
          strength: consecutive,
        });
      }
      consecutive = 1;
    }
  }

  return blocks;
}

// 获取 ICT 数据
async function getICTData(symbol: string, interval: string) {
  const priceRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
  const priceData = await priceRes.json();
  const currentPrice = priceData.price || '未知';

  const klineRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=200`);
  const klinesRaw = await klineRes.json();

  const klines: KLine[] = klinesRaw.map((k: [number, string, string, string, string, string, number]) => ({
    time: new Date(k[0]).toLocaleString('zh-CN'),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));

  const swingPoints = detectSwingPoints(klines, 5);
  const fvg = detectFVG(klines);
  const orderBlocks = detectOrderBlocks(klines);

  return { price: currentPrice, klines, ict: {
    swingHighs: swingPoints.highs.slice(-10),
    swingLows: swingPoints.lows.slice(-10),
    fvgBullish: fvg.bullish.slice(-5),
    fvgBearish: fvg.bearish.slice(-5),
    orderBlocks: orderBlocks.slice(-10),
  }};
}

// 格式化 ICT 数据
function formatICTData(data: { price: string; klines: KLine[]; ict: ICTData }, interval: string): string {
  const { ict } = data;
  const recentKlines = data.klines.slice(-20);
  const price = parseFloat(data.price);

  const todayHigh = recentKlines[recentKlines.length - 1]?.high || price;
  const todayLow = recentKlines[recentKlines.length - 1]?.low || price;
  const dailyRange = todayHigh - todayLow;
  const pricePosition = dailyRange > 0 ? ((price - todayLow) / dailyRange * 100).toFixed(1) : '50';

  const positionLabel = parseFloat(pricePosition) < 38 ? 'Discount Zone (低价买入区)'
    : parseFloat(pricePosition) > 62 ? 'Premium Zone (高价卖出区)'
    : 'Mid-range (中间区)';

  return `【实时 ICT 分析数据】
当前价格: $${data.price} (日内位置: ${pricePosition}%)
日内范围: 高$${todayHigh.toFixed(2)} / 低$${todayLow.toFixed(2)}
当前位置: ${positionLabel}
时间周期: ${interval}

【最近20根K线】
${recentKlines.map(k => `${k.time.slice(-8)} | 收:${k.close.toFixed(2)} 高:${k.high.toFixed(2)} 低:${k.low.toFixed(2)}`).join('\n')}

【Swing Highs】(最近高点-阻力)
${ict.swingHighs.slice(-5).map(s => `$${s.price.toFixed(2)} @ ${s.time.slice(-8)}`).join('\n') || '无'}

【Swing Lows】(最近低点-支撑)
${ict.swingLows.slice(-5).map(s => `$${s.price.toFixed(2)} @ ${s.time.slice(-8)}`).join('\n') || '无'}

【Bullish FVG】(向上跳空-回调买入目标) ${ict.fvgBullish.length}个
${ict.fvgBullish.map(f => `$${f.low.toFixed(2)}-${f.high.toFixed(2)} @ ${f.time.slice(-8)}`).join('\n') || '无'}

【Bearish FVG】(向下跳空-回调卖出目标) ${ict.fvgBearish.length}个
${ict.fvgBearish.map(f => `$${f.low.toFixed(2)}-${f.high.toFixed(2)} @ ${f.time.slice(-8)}`).join('\n') || '无'}

【Bullish Order Blocks】(机构做多区-回调买入)
${ict.orderBlocks.filter(ob => ob.side === 'bull').slice(-3).map(ob => `$${ob.price.toFixed(2)} @ ${ob.time.slice(-8)} (强度:${ob.strength})`).join('\n') || '无'}

【Bearish Order Blocks】(机构做空区-反弹卖出)
${ict.orderBlocks.filter(ob => ob.side === 'bear').slice(-3).map(ob => `$${ob.price.toFixed(2)} @ ${ob.time.slice(-8)} (强度:${ob.strength})`).join('\n') || '无'}
`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, symbol = 'BTC', interval = '15m' } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Invalid messages' }, { status: 400 });
    }

    // 获取 ICT 数据
    let marketData = '';
    try {
      const ictData = await getICTData(symbol, interval);
      marketData = formatICTData(ictData, interval);
    } catch (e) {
      console.error('[Chat API] Failed to get market data:', e);
    }

    const systemPrompt = `你是ICT（Inner Circle Trader）方法论的专业分析师，精通BTC日内和波段交易。

## ICT 核心分析框架

### 1. 市场结构判断
- Bull Trend: 更高高点(HH)和更高低点(HL)
- Bear Trend: 更低高点(LH)和更低低点(LL)
- Consolidation: 趋势不明显

### 2. Killzone（机构活跃时段）
- 亚洲时段(00:00-08:00 UTC): 低波动
- 伦敦时段(08:00-12:00 UTC): 高波动，突破常发生
- 纽约时段(12:00-16:00 UTC): 最大波动

### 3. Order Block
- Bullish OB: 下跌后最后一根阳线（机构建仓区）
- Bearish OB: 上涨后最后一根阴线（机构派发区）

### 4. Fair Value Gap (FVG)
- 价格快速移动留下的真空区
- 未填补的FVG可能成为回撤目标

### 5. 流动性
- BOS: 突破重要波段高低价
- 止损猎杀: 价格去扫掉止损后反转

## 分析要求
按以下框架输出（简洁，5-8句）：
1. 当前结构: 趋势还是震荡？HH/HL还是LH/LL？
2. 关键OB: 最近的有效OB在哪里？
3. FVG状态: 是否有未填补的缺口？
4. 方向判断: 短期偏多还是偏空？
5. 关键价位: 支撑阻力在哪？

用专业但易懂的语言。`;

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `请分析 BTC 当前行情。\n\n${marketData}` },
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
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Chat API] MiniMax error:', error);
      return NextResponse.json({ error: 'AI服务请求失败' }, { status: 500 });
    }

    const result = await response.json();
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
