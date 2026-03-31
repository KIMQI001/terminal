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

// 获取多周期 K 线数据
async function getMultiTimeframeCandles(symbol: string): Promise<{
  candles1h: Candle[];
  candles15m: Candle[];
  currentPrice: string;
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

  const currentPrice = candles15m[candles15m.length - 1].close.toString();

  return { candles1h, candles15m, currentPrice };
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

// 格式化 Swing Points - 区分 HH/HL/LH/LL 结构
function formatSwing(candles: Candle[], currentPrice: string): string {
  const price = parseFloat(currentPrice);
  const swings = detectSwingPoints(candles, 5);
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  if (highs.length < 2 || lows.length < 2) {
    return `【市场结构】数据不足`;
  }

  // 获取最近的结构点
  const recentHighs = highs.slice(-5);
  const recentLows = lows.slice(-5);

  // 分类 HH/HL/LH/LL
  let hh = '', hl = '', lh = '', ll = '';
  let trend = 'neutral';

  // 分析结构
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

  // 判断趋势
  if (hh && hl) {
    trend = 'bullish';
  } else if (lh && ll) {
    trend = 'bearish';
  }

  // 最近的阻力/支撑
  const nearestHigh = recentHighs[recentHighs.length - 1];
  const nearestLow = recentLows[recentLows.length - 1];

  // 价格位置分析
  let position = '';
  let nextTarget = '';
  let support = '';

  if (trend === 'bullish') {
    // 多头趋势：接近 HL 支撑，或突破 HH
    if (price < parseFloat(hl)) {
      position = `价格低于HL(${hl})，可能回踩`;
      support = hl;
      nextTarget = hh;
    } else if (price > parseFloat(hh)) {
      position = `价格突破HH(${hh})，多头延续`;
      support = hl;
      nextTarget = '新高';
    } else {
      position = `价格在HH(${hh})和HL(${hl})之间震荡`;
      support = hl;
      nextTarget = hh;
    }
  } else if (trend === 'bearish') {
    // 空头趋势：接近 LH 阻力，或突破 LL
    if (price > parseFloat(lh)) {
      position = `价格高于LH(${lh})，可能反弹`;
      nextTarget = ll;
      support = lh;
    } else if (price < parseFloat(ll)) {
      position = `价格跌破LL(${ll})，空头延续`;
      nextTarget = '新低';
      support = lh;
    } else {
      position = `价格在LH(${lh})和LL(${ll})之间震荡`;
      nextTarget = ll;
      support = lh;
    }
  }

  return `【市场结构分析】
当前趋势: ${trend === 'bullish' ? '🟢 多头' : trend === 'bearish' ? '🔴 空头' : '⚪ 中性'}
当前位置: ${position}

【关键价位】
更高高点(HH): ${hh || '无'}
更高低点(HL): ${hl || '无'} ← 重要支撑
更低高点(LH): ${lh || '无'} ← 重要阻力
更低低点(LL): ${ll || '无'}

【当前价格】: $${currentPrice}
【上行目标】: ${nextTarget}
【下方支撑】: ${support}`;
}

// 分析单周期结构数据
interface StructureData {
  trend: 'bullish' | 'bearish' | 'neutral';
  hh: string;
  hl: string;
  lh: string;
  ll: string;
  position: string;
  nextTarget: string;
  support: string;
  nearestHigh: string;
  nearestLow: string;
}

function analyzeStructure(candles: Candle[], currentPrice: string): StructureData {
  const price = parseFloat(currentPrice);
  const swings = detectSwingPoints(candles, 5);
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'neutral', hh: '', hl: '', lh: '', ll: '', position: '数据不足', nextTarget: '', support: '', nearestHigh: '', nearestLow: '' };
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
    if (price < parseFloat(hl)) {
      position = `价格低于HL(${hl})，回踩中`;
      support = hl;
      nextTarget = hh;
    } else if (price > parseFloat(hh)) {
      position = `突破HH(${hh})，多头延续`;
      support = hl;
      nextTarget = '新高';
    } else {
      position = `HH(${hh})与HL(${hl})之间`;
      support = hl;
      nextTarget = hh;
    }
  } else if (trend === 'bearish') {
    if (price > parseFloat(lh)) {
      position = `价格高于LH(${lh})，反弹中`;
      nextTarget = ll;
      support = lh;
    } else if (price < parseFloat(ll)) {
      position = `跌破LL(${ll})，空头延续`;
      nextTarget = '新低';
      support = lh;
    } else {
      position = `LH(${lh})与LL(${ll})之间`;
      nextTarget = ll;
      support = lh;
    }
  }

  const nearestHigh = recentHighs[recentHighs.length - 1];
  const nearestLow = recentLows[recentLows.length - 1];

  return {
    trend,
    hh,
    hl,
    lh,
    ll,
    position,
    nextTarget,
    support,
    nearestHigh: nearestHigh ? `$${nearestHigh.price.toFixed(2)}` : '',
    nearestLow: nearestLow ? `$${nearestLow.price.toFixed(2)}` : '',
  };
}

// 格式化多周期结构分析
function formatMultiTimeframeStructure(
  candles1h: Candle[],
  candles15m: Candle[],
  currentPrice: string
): string {
  const price = parseFloat(currentPrice);
  const structure1h = analyzeStructure(candles1h, currentPrice);
  const structure15m = analyzeStructure(candles15m, currentPrice);

  // 综合分析
  let overallTrend = 'neutral';
  let analysis = '';

  // 1H 决定大方向，15m 找入场点
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
当前价格: $${currentPrice}
综合判断: ${overallTrend} - ${analysis}

━━━━━━━━ 1H 大周期 ━━━━━━━━
趋势: ${structure1h.trend === 'bullish' ? '🟢 多头' : structure1h.trend === 'bearish' ? '🔴 空头' : '⚪ 中性'}
位置: ${structure1h.position}
HH: ${structure1h.hh || '无'} | HL: ${structure1h.hl || '无'} (支撑)
LH: ${structure1h.lh || '无'} (阻力) | LL: ${structure1h.ll || '无'}

━━━━━━━━ 15m 小周期 ━━━━━━━━
趋势: ${structure15m.trend === 'bullish' ? '🟢 多头' : structure15m.trend === 'bearish' ? '🔴 空头' : '⚪ 中性'}
位置: ${structure15m.position}
HH: ${structure15m.hh || '无'} | HL: ${structure15m.hl || '无'} (支撑)
LH: ${structure15m.lh || '无'} (阻力) | LL: ${structure15m.ll || '无'}

【关键决策】
1H ${structure1h.trend === 'bullish' ? '做多为主' : structure1h.trend === 'bearish' ? '做空为主' : '观望'}
15m ${structure15m.position}
入场参考: 15m回踩 ${structure15m.hl || structure1h.hl || '支撑位'} 可尝试做多
止损参考: 跌破 ${structure15m.ll || structure1h.ll || '前低'}`;
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

${formatSwing(candles, currentPrice)}
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

    // 获取多周期数据 (1H + 15m)
    const { candles1h, candles15m } = await getMultiTimeframeCandles(symbol);

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
        skillData += `\n${formatMultiTimeframeStructure(candles1h, candles15m, currentPrice)}`;
      }
      if (intents.includes('orderblocks')) {
        skillData += `\n${formatOB(candles)}`;
      }
      if (intents.includes('swing')) {
        skillData += `\n${formatMultiTimeframeStructure(candles1h, candles15m, currentPrice)}`;
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
