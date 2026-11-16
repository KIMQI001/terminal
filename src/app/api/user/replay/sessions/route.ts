import { NextRequest, NextResponse } from 'next/server';
import { replayQueries, type ReplayTradeInput } from '@/lib/db';
import { verifyToken, extractTokenFromHeader } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MAX_TRADES = 1000;

async function authenticateUser(request: NextRequest): Promise<{ userId: number; username: string } | null> {
  const authHeader = request.headers.get('Authorization');
  const token = extractTokenFromHeader(authHeader);
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return null;
  return { userId: payload.userId, username: payload.username };
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

// GET /api/user/replay/sessions - 列出回放场次
export async function GET(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const sp = request.nextUrl.searchParams;
    const limit = parseInt(sp.get('limit') || '50', 10);
    const offset = parseInt(sp.get('offset') || '0', 10);
    const symbol = sp.get('symbol') || undefined;

    const sessions = replayQueries.listByUser(user.userId, {
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      symbol,
    });

    return NextResponse.json({ success: true, sessions });
  } catch (error) {
    console.error('List replay sessions error:', error);
    return NextResponse.json({ error: '获取回放记录失败' }, { status: 500 });
  }
}

// POST /api/user/replay/sessions - 保存一场回放
export async function POST(request: NextRequest) {
  const user = await authenticateUser(request);
  if (!user) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  try {
    const body = await request.json();

    const symbol = String(body?.symbol ?? '').trim();
    const timeframe = String(body?.timeframe ?? '').trim();
    if (!symbol || !timeframe) {
      return NextResponse.json({ error: '缺少 symbol / timeframe' }, { status: 400 });
    }

    const rawTrades = Array.isArray(body?.trades) ? body.trades : [];
    if (rawTrades.length > MAX_TRADES) {
      return NextResponse.json({ error: `逐笔明细过多（最多 ${MAX_TRADES} 条）` }, { status: 400 });
    }

    const trades: ReplayTradeInput[] = rawTrades.map((t: Record<string, unknown>, i: number) => ({
      seq: num(t?.seq, i + 1),
      side: t?.side === 'sell' ? 'sell' : 'buy',
      quantity: num(t?.quantity),
      entryPrice: num(t?.entryPrice),
      entryTime: num(t?.entryTime),
      entryBar: num(t?.entryBar),
      exitPrice: t?.exitPrice == null ? null : num(t?.exitPrice),
      exitTime: t?.exitTime == null ? null : num(t?.exitTime),
      exitBar: t?.exitBar == null ? null : num(t?.exitBar),
      exitReason: t?.exitReason == null ? null : String(t?.exitReason),
      stopLoss: t?.stopLoss == null ? null : num(t?.stopLoss),
      takeProfit: t?.takeProfit == null ? null : num(t?.takeProfit),
      margin: num(t?.margin),
      riskAmount: num(t?.riskAmount),
      pnl: num(t?.pnl),
      pnlPct: num(t?.pnlPct),
      rMultiple: num(t?.rMultiple),
      mae: num(t?.mae),
      mfe: num(t?.mfe),
      entryScore: t?.entryScore == null ? null : num(t?.entryScore),
      entryDeductions: t?.entryDeductions ?? null,
      disciplineFlags: t?.disciplineFlags ?? null,
    }));

    const account = (body?.account ?? {}) as Record<string, unknown>;
    const score = (body?.score ?? {}) as Record<string, unknown>;
    const sections = Array.isArray(score?.sections) ? (score?.sections as Record<string, unknown>[]) : [];
    const sectionScore = (key: string) => {
      const s = sections.find((x) => x?.key === key);
      return s ? num(s?.score) : 0;
    };

    const initialCapital = num(body?.config?.initialCapital, num(account?.initialCapital, 1000));
    const equityCurve = Array.isArray(body?.equityCurve) ? body.equityCurve : [];
    const maxDrawdownPct = equityCurve.reduce((m: number, p: Record<string, unknown>) => {
      const d = num(p?.drawdownPct);
      return d > m ? d : m;
    }, 0);

    const id = replayQueries.insertSession(
      user.userId,
      {
        symbol,
        timeframe,
        barCount: num(body?.barCount, 0),
        barsReplayed: num(body?.barsReplayed, 0),
        initialCapital,
        quantity: num(body?.config?.quantity, 0.001),
        leverage: num(body?.config?.leverage, 1),
        finalEquity: num(account?.equity),
        realizedPnl: num(account?.realizedPnl),
        unrealizedPnl: num(account?.unrealizedPnl),
        netPnl: 0, // 服务端按 trades 重算
        returnPct: 0,
        maxDrawdownPct,
        totalTrades: trades.length,
        winCount: 0,
        lossCount: 0,
        winRate: 0,
        profitFactor: null,
        expectancyR: null,
        scoreTotal: num(score?.total),
        scoreProfit: sectionScore('profit'),
        scoreEntry: sectionScore('entry'),
        scoreDiscipline: sectionScore('discipline'),
        grade: score?.grade == null ? null : String(score.grade),
        scoreDetails: score,
        equityCurve,
        config: body?.config ?? null,
        startedAt: num(body?.startedAt),
        endedAt: num(body?.endedAt),
      },
      trades
    );

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error('Save replay session error:', error);
    return NextResponse.json({ error: '保存回放记录失败' }, { status: 500 });
  }
}
