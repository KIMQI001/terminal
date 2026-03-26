/**
 * Chat API - AI 对话接口
 * POST /api/chat - 发送消息获取AI回复
 */
import { NextRequest, NextResponse } from 'next/server';

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'sk-cp-HVHq56Z8XxY50HLWX3jhYoXFbXT7SNGFzDeOgssECOjhJaUf_D6ZpLigReVSJkRd-RQ7R7si1_VNC_c89uqz4VIJ0LCFZmzSCiSrEQFGKfLD6Hm5Fha3gA0';

// 导入指标库
import {
  detectFVGs,
  detectSwingPoints,
  detectOrderBlocks,
  detectMarketStructure,
  detectLiquidityZones,
  Candle,
} from '@/lib/indicators/skillIndicators';

// K线数据
interface KLine {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

// 获取 K 线数据
async function getCandles(symbol: string, interval: string): Promise<{ candles: Candle[]; currentPrice: string }> {
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

  const currentPrice = candles[candles.length - 1].close.toString();

  return { candles, currentPrice };
}

// 检测用户询问意图
function detectUserIntent(message: string): string[] {
  const intents: string[] = [];
  const msg = message.toLowerCase();

  if (msg.includes('结构') || msg.includes('趋势') || msg.includes('bos') || msg.includes('chch')) {
    intents.push('structure');
  }
  if (msg.includes('fvg') || msg.includes('缺口') || msg.includes('跳空') || msg.includes('gap')) {
    intents.push('fvg');
  }
  if (msg.includes('ob') || msg.includes('order block') || msg.includes('订单块') || msg.includes('机构')) {
    intents.push('orderblocks');
  }
  if (msg.includes('swing') || msg.includes('高低点') || msg.includes('支撑') || msg.includes('阻力')) {
    intents.push('swing');
  }
  if (msg.includes('流动性') || msg.includes('止损') || msg.includes('猎杀') || msg.includes('liquidity')) {
    intents.push('liquidity');
  }
  if (msg.includes('全面') || msg.includes('完整') || msg.includes('分析')) {
    intents.push('full');
  }

  // 默认包含基础数据
  if (intents.length === 0) {
    intents.push('basic');
  }

  return intents;
}

// 格式化结构分析
function formatStructure(candles: Candle[]): string {
  const ms = detectMarketStructure(candles);
  return `【市场结构分析】
趋势: ${ms.trend === 'bull' ? '多头↑' : ms.trend === 'bear' ? '空头↓' : '中性'}
${ms.lastHH ? `更高高点(HH): $${ms.lastHH.toFixed(2)}` : ''}
${ms.lastHL ? `更高低点(HL): $${ms.lastHL.toFixed(2)}` : ''}
${ms.lastLH ? `更低高点(LH): $${ms.lastLH.toFixed(2)}` : ''}
${ms.lastLL ? `更低低点(LL): $${ms.lastLL.toFixed(2)}` : ''}
结构突破: ${ms.structureBroken ? '⚠️ 已突破' : '✅ 未突破'}`;
}

// 格式化 FVG 分析
function formatFVG(candles: Candle[]): string {
  const fvgs = detectFVGs(candles);
  const unfilledBull = fvgs.filter(f => f.direction === 'bull' && !f.filled);
  const unfilledBear = fvgs.filter(f => f.direction === 'bear' && !f.filled);

  return `【FVG 缺口分析】
总FVG数: ${fvgs.length}
未填补看涨FVG: ${unfilledBull.length}个
${unfilledBull.slice(-3).map(f => `  $${f.low.toFixed(2)}-${f.high.toFixed(2)} (${f.fillPercent.toFixed(0)}%已填补)`).join('\n') || '  无'}
未填补看跌FVG: ${unfilledBear.length}个
${unfilledBear.slice(-3).map(f => `  $${f.low.toFixed(2)}-${f.high.toFixed(2)} (${f.fillPercent.toFixed(0)}%已填补)`).join('\n') || '  无'}`;
}

// 获取多周期 FVG 分析
async function getMultiTimeframeFVG(symbol: string): Promise<string> {
  const intervals = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const currentPrice = parseFloat((await getCandles(symbol, '1m')).currentPrice);
  let result = '【多周期 FVG 分析 - 填补<25%的机会】\n\n';

  for (const interval of intervals) {
    try {
      const { candles } = await getCandles(symbol, interval);
      const fvgs = detectFVGs(candles);

      // 找填补小于25%的FVG（接近填补完毕）
      const nearFullBull = fvgs.filter(f => f.direction === 'bull' && f.fillPercent >= 75 && f.fillPercent < 100);
      const nearFullBear = fvgs.filter(f => f.direction === 'bear' && f.fillPercent >= 75 && f.fillPercent < 100);

      // 完全未填补的
      const openBull = fvgs.filter(f => f.direction === 'bull' && f.fillPercent < 25);
      const openBear = fvgs.filter(f => f.direction === 'bear' && f.fillPercent < 25);

      const nearCount = nearFullBull.length + nearFullBear.length;
      const openCount = openBull.length + openBear.length;

      if (nearCount > 0 || openCount > 0) {
        result += `【${interval}】当前价格: $${currentPrice.toFixed(2)}\n`;

        if (nearCount > 0) {
          result += `  ⚠️ 即将填补(${nearCount}个):\n`;
          [...nearFullBull, ...nearFullBear].slice(-2).forEach(f => {
            result += `    $${f.low.toFixed(2)}-${f.high.toFixed(2)} ${f.direction === 'bull' ? '多' : '空'} (${f.fillPercent.toFixed(0)}%已填补)\n`;
          });
        }

        if (openCount > 0) {
          result += `  🕐 未填补(${openCount}个):\n`;
          [...openBull, ...openBear].slice(-2).forEach(f => {
            result += `    $${f.low.toFixed(2)}-${f.high.toFixed(2)} ${f.direction === 'bull' ? '多' : '空'} (${f.fillPercent.toFixed(0)}%已填补)\n`;
          });
        }
        result += '\n';
      }
    } catch (e) {
      // 忽略错误继续下一个周期
    }
  }

  return result || '各周期无明显FVG机会';
}

// 格式化 OB 分析
function formatOB(candles: Candle[]): string {
  const obs = detectOrderBlocks(candles);
  const bullObs = obs.filter(ob => ob.side === 'bull');
  const bearObs = obs.filter(ob => ob.side === 'bear');

  return `【Order Block 分析】
总OB数: ${obs.length}
看涨OB (回调买入): ${bullObs.length}个
${bullObs.slice(-3).map(ob => `  $${ob.price.toFixed(2)} @ ${new Date(ob.time).toLocaleString('zh-CN').slice(-8)} (强度:${ob.strength})`).join('\n') || '  无'}
看跌OB (反弹卖出): ${bearObs.length}个
${bearObs.slice(-3).map(ob => `  $${ob.price.toFixed(2)} @ ${new Date(ob.time).toLocaleString('zh-CN').slice(-8)} (强度:${ob.strength})`).join('\n') || '  无'}`;
}

// 格式化 Swing Points
function formatSwing(candles: Candle[]): string {
  const swings = detectSwingPoints(candles, 5);
  const highs = swings.filter(s => s.type === 'high').slice(-5);
  const lows = swings.filter(s => s.type === 'low').slice(-5);

  return `【波段高低点】
阻力(近期高点): ${highs.length > 0 ? highs.map(h => `$${h.price.toFixed(2)}`).join(' > ') : '无'}
支撑(近期低点): ${lows.length > 0 ? lows.map(l => `$${l.price.toFixed(2)}`).join(' > ') : '无'}`;
}

// 格式化流动性分析
function formatLiquidity(candles: Candle[]): string {
  const liq = detectLiquidityZones(candles);

  return `【流动性分析】
检测到流动性区域: ${liq.length}个
${liq.slice(-5).map(l => `${l.type === 'sweep' ? '🔍 猎杀' : '💧 池'} $${l.price.toFixed(2)} ${l.direction === 'bull' ? '向上' : '向下'}`).join('\n') || '无明显流动性区域'}`;
}

// 获取基础 ICT 数据（用于默认分析）
function getBasicICTData(candles: Candle[], currentPrice: string) {
  const price = parseFloat(currentPrice);
  const recentKlines = candles.slice(-20);
  const todayHigh = recentKlines[recentKlines.length - 1]?.high || price;
  const todayLow = recentKlines[recentKlines.length - 1]?.low || price;
  const dailyRange = todayHigh - todayLow;
  const pricePosition = dailyRange > 0 ? ((price - todayLow) / dailyRange * 100).toFixed(1) : '50';

  const positionLabel = parseFloat(pricePosition) < 38 ? 'Discount Zone (低价买入区)'
    : parseFloat(pricePosition) > 62 ? 'Premium Zone (高价卖出区)'
    : 'Mid-range (中间区)';

  const swings = detectSwingPoints(candles, 5);
  const fvgs = detectFVGs(candles);
  const obs = detectOrderBlocks(candles);

  return `【实时 ICT 数据】
当前价格: $${currentPrice} (日内位置: ${pricePosition}%)
当前位置: ${positionLabel}
数据基础: ${candles.length}根K线

【最近20根K线】
${recentKlines.map(k => `${new Date(k.time).toLocaleString('zh-CN').slice(-8)} | 收:${k.close.toFixed(2)} 高:${k.high.toFixed(2)} 低:${k.low.toFixed(2)}`).join('\n')}

${formatStructure(candles)}

${formatFVG(candles)}

${formatOB(candles)}

${formatSwing(candles)}
`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, symbol = 'BTC', interval = '15m' } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Invalid messages' }, { status: 400 });
    }

    // 获取 K 线数据
    const { candles, currentPrice } = await getCandles(symbol, interval);

    // 检测用户询问意图
    const lastMessage = messages[messages.length - 1]?.content || '';
    const intents = detectUserIntent(lastMessage);

    // 根据意图构建数据 - 默认包含所有ICT数据
    let skillData = '';

    if (intents.includes('full')) {
      // 完整分析
      skillData = `
${getBasicICTData(candles, currentPrice)}
${formatLiquidity(candles)}
`;
    } else {
      // 基础数据 + 多周期FVG（默认注入）
      skillData = getBasicICTData(candles, currentPrice);

      // 默认添加多周期FVG分析
      const mtfFvg = await getMultiTimeframeFVG(symbol);
      skillData += `\n${mtfFvg}`;

      if (intents.includes('structure')) {
        skillData += `\n${formatStructure(candles)}`;
      }
      if (intents.includes('orderblocks')) {
        skillData += `\n${formatOB(candles)}`;
      }
      if (intents.includes('swing')) {
        skillData += `\n${formatSwing(candles)}`;
      }
      if (intents.includes('liquidity')) {
        skillData += `\n${formatLiquidity(candles)}`;
      }
    }

    const systemPrompt = `你是BTC FVG数据查询助手。

## 数据已提供
下方提供了 BTC 各周期（5m/15m/1h/4h/1d）的 FVG 数据，包含多空方向、价格区间和填补百分比。
🟢=看涨FVG 🔴=看跌FVG

## 你的任务
用户问什么，你就只回答什么。不要自己分析或总结，只返回用户需要的数据。

如果用户问"价格附近的FVG"，找出价格区间最接近的那些FVG。
如果用户问"最近的FVG"，返回离当前价格最近的那些FVG。
如果用户问"有多少个"，直接告诉数量。

简洁回答，只说用户问的东西，不要多余的话。`;

    // 构建消息：把数据注入到用户的最新消息中
    const lastUserMessage = messages.length > 0 ? messages[messages.length - 1].content : 'BTC现在什么情况';
    const userMessageWithData = `${lastUserMessage}\n\n【K线数据】\n${skillData}`;

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(0, -1).map((m: { role: string; content: string }) => ({
        role: m.role,
        content: m.content,
      })),
      { role: 'user', content: userMessageWithData },
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
