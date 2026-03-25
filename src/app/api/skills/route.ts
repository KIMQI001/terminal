/**
 * Skills API - AI 可以调用的指标技能
 * POST /api/skills - 执行技能分析
 */
import { NextRequest, NextResponse } from 'next/server';

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || 'sk-cp-HVHq56Z8XxY50HLWX3jhYoXFbXT7SNGFzDeOgssECOjhJaUf_D6ZpLigReVSJkRd-RQ7R7si1_VNC_c89uqz4VIJ0LCFZmzSCiSrEQFGKfLD6Hm5Fha3gA0';

export async function GET() {
  // 返回可用技能列表
  return NextResponse.json({
    success: true,
    skills: [
      {
        name: 'get_market_structure',
        description: '获取市场结构分析（趋势方向、结构突破）',
        params: { symbol: 'BTC', interval: '15m' },
      },
      {
        name: 'get_fvg_zones',
        description: '获取FVG区域及填补状态',
        params: { symbol: 'BTC', interval: '15m' },
      },
      {
        name: 'get_order_blocks',
        description: '获取Order Block订单块',
        params: { symbol: 'BTC', interval: '15m' },
      },
      {
        name: 'get_swing_points',
        description: '获取波段高低点',
        params: { symbol: 'BTC', interval: '15m' },
      },
      {
        name: 'get_liquidity_zones',
        description: '获取流动性区域',
        params: { symbol: 'BTC', interval: '15m' },
      },
      {
        name: 'full_analysis',
        description: '获取完整ICT分析（包含以上所有）',
        params: { symbol: 'BTC', interval: '15m' },
      },
    ],
  });
}

// 导入指标库
import {
  detectFVGs,
  detectSwingPoints,
  detectOrderBlocks,
  detectMarketStructure,
  detectLiquidityZones,
  Candle,
} from '@/lib/indicators/skillIndicators';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { skill, symbol = 'BTC', interval = '15m' } = body;

    // 获取 K 线数据
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

    let result: any = { skill, symbol, interval, currentPrice };

    switch (skill) {
      case 'get_market_structure': {
        const ms = detectMarketStructure(candles);
        result.data = ms;
        result.summary = `${ms.trend === 'bull' ? '多头趋势' : ms.trend === 'bear' ? '空头趋势' : '中性'} | 结构${ms.structureBroken ? '已突破' : '未突破'}`;
        break;
      }

      case 'get_fvg_zones': {
        const fvgs = detectFVGs(candles);
        const unfilledBull = fvgs.filter(f => f.direction === 'bull' && !f.filled);
        const unfilledBear = fvgs.filter(f => f.direction === 'bear' && !f.filled);
        result.data = { fvgs, unfilledBull, unfilledBear };
        result.summary = `共${fvgs.length}个FVG | 未填补:${unfilledBull.length}个看涨, ${unfilledBear.length}个看跌`;
        break;
      }

      case 'get_order_blocks': {
        const obs = detectOrderBlocks(candles);
        const bullObs = obs.filter(ob => ob.side === 'bull');
        const bearObs = obs.filter(ob => ob.side === 'bear');
        result.data = { orderBlocks: obs, bullObs, bearObs };
        result.summary = `共${obs.length}个OB | ${bullObs.length}个看涨, ${bearObs.length}个看跌`;
        break;
      }

      case 'get_swing_points': {
        const swings = detectSwingPoints(candles, 5);
        const highs = swings.filter(s => s.type === 'high').slice(-5);
        const lows = swings.filter(s => s.type === 'low').slice(-5);
        result.data = { swings, highs, lows };
        result.summary = `最近高点: $${highs[highs.length - 1]?.price.toFixed(2)} | 最近低点: $${lows[lows.length - 1]?.price.toFixed(2)}`;
        break;
      }

      case 'get_liquidity_zones': {
        const liq = detectLiquidityZones(candles);
        result.data = { liquidityZones: liq };
        result.summary = `检测到${liq.length}个流动性区域`;
        break;
      }

      case 'full_analysis':
      default: {
        const ms = detectMarketStructure(candles);
        const fvgs = detectFVGs(candles);
        const obs = detectOrderBlocks(candles);
        const swings = detectSwingPoints(candles, 5);
        const liq = detectLiquidityZones(candles);

        const unfilledBullFvg = fvgs.filter(f => f.direction === 'bull' && !f.filled);
        const unfilledBearFvg = fvgs.filter(f => f.direction === 'bear' && !f.filled);
        const bullObs = obs.filter(ob => ob.side === 'bull');
        const bearObs = obs.filter(ob => ob.side === 'bear');
        const recentHighs = swings.filter(s => s.type === 'high').slice(-3);
        const recentLows = swings.filter(s => s.type === 'low').slice(-3);

        result.data = {
          marketStructure: ms,
          fvg: { all: fvgs, unfilledBull: unfilledBullFvg, unfilledBear: unfilledBearFvg },
          orderBlocks: { all: obs, bull: bullObs, bear: bearObs },
          swingPoints: { highs: recentHighs, lows: recentLows },
          liquidity: liq,
        };

        result.summary = `
结构: ${ms.trend === 'bull' ? '多头↑' : ms.trend === 'bear' ? '空头↓' : '中性'}
FVG: ${unfilledBullFvg.length}个未填补看涨 / ${unfilledBearFvg.length}个未填补看跌
OB: ${bullObs.length}个看涨 / ${bearObs.length}个看跌
阻力: $${recentHighs[recentHighs.length - 1]?.price.toFixed(2)}
支撑: $${recentLows[recentLows.length - 1]?.price.toFixed(2)}
`.trim();
        break;
      }
    }

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('[Skills API] Error:', error);
    return NextResponse.json({ error: '技能执行失败' }, { status: 500 });
  }
}
