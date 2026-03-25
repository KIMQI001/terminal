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
  mitigationBlocks: { time: string; price: number; side: 'bull' | 'bear' }[];
}

// 检测 Swing Points
function detectSwingPoints(klines: KLine[], lookback: number = 5): { highs: { time: string; price: number }[]; lows: { time: string; price: number }[] } {
  const highs: { time: string; price: number }[] = [];
  const lows: { time: string; price: number }[] = [];

  for (let i = lookback; i < klines.length - lookback; i++) {
    const isHigh = klines.slice(i - lookback, i + lookback + 1).every((k, idx) => {
      if (idx === lookback) return true;
      return k.high <= klines[i].high;
    });
    if (isHigh) highs.push({ time: klines[i].time, price: klines[i].high });

    const isLow = klines.slice(i - lookback, i + lookback + 1).every((k, idx) => {
      if (idx === lookback) return true;
      return k.low >= klines[i].low;
    });
    if (isLow) lows.push({ time: klines[i].time, price: klines[i].low });
  }

  return { highs, lows };
}

// 检测 FVG (Fair Value Gap)
function detectFVG(klines: KLine[]): { bullish: { time: string; high: number; low: number }[]; bearish: { time: string; high: number; low: number }[] } {
  const bullish: { time: string; high: number; low: number }[] = [];
  const bearish: { time: string; high: number; low: number }[] = [];

  for (let i = 2; i < klines.length; i++) {
    const prev = klines[i - 2];
    const curr = klines[i];
    const mid = klines[i - 1];

    // 阳阴阴 bullish FVG: 第一根阳线，中间阴线向上跳空
    if (prev.close > prev.open && curr.close < curr.open) {
      if (mid.low > prev.high) {
        bullish.push({ time: mid.time, high: mid.high, low: mid.low });
      }
    }

    // 阴阳阳 bearish FVG: 第一根阴线，中间阳线向下跳空
    if (prev.close < prev.open && curr.close > curr.open) {
      if (mid.high < prev.low) {
        bearish.push({ time: mid.time, high: mid.high, low: mid.low });
      }
    }
  }

  return { bullish, bearish };
}

// 检测 Order Block (最后一个同色蜡烛作为 OB)
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
      // 方向改变，统计连续同色蜡烛的数量和均值
      if (consecutive >= 1) {
        const sumHigh = klines.slice(i - consecutive, i).reduce((s, k) => s + k.high, 0);
        const sumLow = klines.slice(i - consecutive, i).reduce((s, k) => s + k.low, 0);
        const avgPrice = prev.close > prev.open
          ? (sumLow / consecutive + sumHigh / consecutive) / 2  // bull OB 取高低均值
          : (sumLow / consecutive + sumHigh / consecutive) / 2; // bear OB

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

// 检测 Mitigation Block (价格被拒绝的区域)
function detectMitigationBlocks(klines: KLine[], recentCount: number = 10): { time: string; price: number; side: 'bull' | 'bear' }[] {
  const blocks: { time: string; price: number; side: 'bull' | 'bear' }[] = [];
  const recent = klines.slice(-recentCount);

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].close > recent[i].open && recent[i - 1].close < recent[i - 1].close) {
      // 向上涨，但前一根是阴线且收盘在低位 - 可能是 bull MB
      if (recent[i].low < recent[i - 1].low) {
        blocks.push({ time: recent[i].time, price: recent[i].low, side: 'bull' });
      }
    }
    if (recent[i].close < recent[i].open && recent[i - 1].close > recent[i - 1].open) {
      // 向下跌，但前一根是阳线 - 可能是 bear MB
      if (recent[i].high > recent[i - 1].high) {
        blocks.push({ time: recent[i].time, price: recent[i].high, side: 'bear' });
      }
    }
  }

  return blocks;
}

// 获取市场数据
async function getICTData(symbol: string, interval: string): Promise<{ price: string; klines: KLine[]; ict: ICTData }> {
  // 获取当前价格
  const priceRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
  const priceData = await priceRes.json();
  const currentPrice = priceData.price || '未知';

  // 获取K线 - 200根
  const klineRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=200`);
  const klinesRaw = await klineRes.json();

  // 解析K线
  const klines: KLine[] = klinesRaw.map((k: [number, string, string, string, string, string, number]) => ({
    time: new Date(k[0]).toLocaleString('zh-CN'),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));

  // 检测 ICT 概念
  const swingPoints = detectSwingPoints(klines, 5);
  const fvg = detectFVG(klines);
  const orderBlocks = detectOrderBlocks(klines);
  const mitigationBlocks = detectMitigationBlocks(klines, 20);

  return {
    price: currentPrice,
    klines,
    ict: {
      swingHighs: swingPoints.highs.slice(-10),
      swingLows: swingPoints.lows.slice(-10),
      fvgBullish: fvg.bullish.slice(-5),
      fvgBearish: fvg.bearish.slice(-5),
      orderBlocks: orderBlocks.slice(-10),
      mitigationBlocks: mitigationBlocks.slice(-10),
    },
  };
}

// 格式化 ICT 数据给 AI
function formatICTData(data: { price: string; klines: KLine[]; ict: ICTData }, interval: string): string {
  const { ict } = data;
  const recentKlines = data.klines.slice(-200);  // 显示全部200根K线
  const price = parseFloat(data.price);

  // 计算日内范围
  const todayHigh = recentKlines[recentKlines.length - 1]?.high || price;
  const todayLow = recentKlines[recentKlines.length - 1]?.low || price;
  const dailyRange = todayHigh - todayLow;
  const pricePosition = dailyRange > 0 ? ((price - todayLow) / dailyRange * 100).toFixed(1) : '50';

  // 判断是 discount 还是 premium
  const positionLabel = parseFloat(pricePosition) < 38 ? 'Discount Zone (低价买入区)'
    : parseFloat(pricePosition) > 62 ? 'Premium Zone (高价卖出区)'
    : 'Mid-range (中间区)';

  let msg = `【实时 ICT 分析数据】
当前价格: $${data.price} (日内位置: ${pricePosition}%)
日内范围: 高$${todayHigh.toFixed(2)} / 低$${todayLow.toFixed(2)}
当前位置: ${positionLabel}
时间周期: ${interval}
数据基础: ${data.klines.length}根K线

【最近200根K线】
${recentKlines.map(k => `${k.time.slice(-8)} | 收:${k.close.toFixed(2)} 高:${k.high.toFixed(2)} 低:${k.low.toFixed(2)}`).join('\n')}

【Swing Highs】(最近高点,可能成为阻力)
${ict.swingHighs.slice(-5).map(s => `$${s.price.toFixed(2)} @ ${s.time.slice(-8)}`).join('\n') || '无'}

【Swing Lows】(最近低点,可能成为支撑)
${ict.swingLows.slice(-5).map(s => `$${s.price.toFixed(2)} @ ${s.time.slice(-8)}`).join('\n') || '无'}

【Bullish FVG】(向上跳空缺口-回调买入目标) ${ict.fvgBullish.length}个
${ict.fvgBullish.map(f => `$${f.low.toFixed(2)}-${f.high.toFixed(2)} @ ${f.time.slice(-8)}`).join('\n') || '无'}

【Bearish FVG】(向下跳空缺口-回调卖出目标) ${ict.fvgBearish.length}个
${ict.fvgBearish.map(f => `$${f.low.toFixed(2)}-${f.high.toFixed(2)} @ ${f.time.slice(-8)}`).join('\n') || '无'}

【Bullish Order Blocks】(机构做多区-回调买入)
${ict.orderBlocks.filter(ob => ob.side === 'bull').slice(-3).map(ob => `$${ob.price.toFixed(2)} @ ${ob.time.slice(-8)} (强度:${ob.strength})`).join('\n') || '无'}

【Bearish Order Blocks】(机构做空区-反弹卖出)
${ict.orderBlocks.filter(ob => ob.side === 'bear').slice(-3).map(ob => `$${ob.price.toFixed(2)} @ ${ob.time.slice(-8)} (强度:${ob.strength})`).join('\n') || '无'}
`;

  return msg;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, symbol = 'BTC', interval = '15m', dingtalk = true } = body;

    if (action === 'analyze') {
      let marketData = '';
      try {
        const ictData = await getICTData(symbol, interval);
        marketData = formatICTData(ictData, interval);
      } catch (e) {
        console.error('[Agent API] Failed to get market data:', e);
        marketData = '\n\n无法获取市场数据，请参考当前价格信息。';
      }

      const systemPrompt = `你是ICT（Inner Circle Trader）方法论的专业分析师，精通BTC日内和波段交易。

## ICT 核心分析框架

### 1. 市场结构判断 (Market Structure)
- **Bull Trend**: 价格创出更高高点(HH)和更高低点(HL)
- **Bear Trend**: 价格创出更低高点(LH)和更低低点(LL)
- **Consolidation**: 高低点不断降低(跌势)或抬高(涨势)，趋势不明显
- **CHoCH (Change of Character)**: 结构改变，当前的低点不再创新低或高点不再创新高

### 2. Killzone（机构最活跃时段）
- **亚洲时段 (00:00-08:00 UTC)**: 低波动，常用于积累或消耗
- **伦敦时段 (08:00-12:00 UTC)**: 高波动，突破常发生
- **纽约时段 (12:00-16:00 UTC)**: 最大波动，机构流动性收割
- **日内关键**: 寻找在 Killzone 边界的价格行为

### 3. Order Block（机构订单区块）
- **Bullish OB**: 下跌后最后一根阳线（上涨前积累）
- **Bearish OB**: 上涨后最后一根阴线（下跌前派发）
- OB 代表机构的"成本区"，价格回调到 OB 常被机构护盘

### 4. Fair Value Gap (FVG / 流动性缺口)
- 价格快速移动留下的真空区
- 两种类型：
  - **Mitigated FVG**: 已被填补，结构可能延续
  - **Open FVG**: 未填补，可能成为回撤目标

### 5.流动性分析 (Liquidity)
- **BOS (Break of Structure)**: 突破重要波段高低价
- **Liquidity Runs**: 价格去扫掉止损后反转（止损猎杀）
- 观察价格是否去"猎"流动性：止损池、突破止损、合约持仓密集区

### 6. 关键价位识别
- **Discount Zone**: 价格偏离均值后的低价买入区
- **Premium Zone**: 价格偏离均值后的高价卖出区
- **Mid-range**: 震荡时的平衡区

## 分析要求

请按以下框架输出（简洁，5-8句）：

1. **当前结构**: 现在是趋势还是震荡？HH/HL 还是 LH/LL？
2. **关键OB**: 最近的有效OB在哪里？价格是否接近？
3. **FVG状态**: 是否有未填补的缺口？是否在回调？
4. **流动性猎杀**: 价格是否在去扫流动性？
5. **方向判断**: 短期(1-4H)偏多还是偏空？
6. **关键价位**: 关键支撑/阻力在哪？止损放哪里？

用专业但易懂的语言，不要废话。`;

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
            { role: 'user', content: `分析 BTC 当前行情。\n\n${marketData}` },
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
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
