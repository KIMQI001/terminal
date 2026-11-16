import type { Candle } from "@/types/chart";
import { clamp } from "./engine";
import { createContextBuilder, evaluateEntryQuality } from "./entryQuality";
import type {
  ReplayAccount,
  ReplayConfig,
  ReplayOrder,
  ReplayScore,
  ReplayScoreSection,
  ReplayTrade,
  ScoreItem,
} from "./types";

/**
 * 综合评分 = 盈利 40% + 进场位置质量 30% + 风控纪律 30%
 *
 * 每一条扣分都带 tradeSeq，可追溯到具体哪一笔交易。
 */

function gradeOf(total: number): string {
  if (total >= 90) return "A+";
  if (total >= 80) return "A";
  if (total >= 70) return "B";
  if (total >= 60) return "C";
  if (total >= 50) return "D";
  return "E";
}

/** 盈利分（权重 40%） */
export function scoreProfit(
  trades: ReplayTrade[],
  account: ReplayAccount
): { score: number; items: ScoreItem[] } {
  const items: ScoreItem[] = [];

  const netPnl = account.realizedPnl + account.unrealizedPnl;
  const pnlPct = account.initialCapital > 0 ? (netPnl / account.initialCapital) * 100 : 0;

  // 子项 A：收益率（满分 60，基准 50）
  const pnlScore = clamp(50 + pnlPct * 5, 0, 60);
  items.push({
    label: "收益率",
    points: Number((pnlScore - 50).toFixed(1)),
    detail: `净盈亏 ${netPnl.toFixed(2)} USDT（${pnlPct.toFixed(2)}%），收益分 ${(pnlScore - 50).toFixed(1)}`,
  });

  // 子项 B：交易效率（满分 40，基准 40）
  let efficiencyScore = 0;
  const closed = trades;
  if (closed.length === 0) {
    items.push({
      label: "无已平仓交易",
      points: -40,
      detail: "本次回放没有已平仓的交易，无法评估交易效率",
    });
  } else {
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl < 0);
    const winRate = wins.length / closed.length;
    const avgWinR = wins.length > 0 ? wins.reduce((s, t) => s + t.rMultiple, 0) / wins.length : 0;
    const avgLossR = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0) / losses.length) : 0;
    const expectancy = winRate * avgWinR - (1 - winRate) * avgLossR;
    efficiencyScore = clamp(40 + expectancy * 20, 0, 40);
    items.push({
      label: "交易效率",
      points: Number((efficiencyScore - 40).toFixed(1)),
      detail: `胜率 ${(winRate * 100).toFixed(0)}%（${wins.length}/${closed.length}），期望值 ${expectancy.toFixed(2)}R`,
    });
  }

  return { score: clamp(pnlScore + efficiencyScore, 0, 100), items };
}

/** 进场位置质量（权重 30%） */
export function scoreEntry(
  trades: ReplayTrade[],
  bars: Candle[],
  orders: ReplayOrder[]
): { score: number; items: ScoreItem[] } {
  const items: ScoreItem[] = [];
  if (trades.length === 0) {
    items.push({
      label: "没有交易",
      points: -100,
      detail: "本次回放没有成交的交易，无法评估进场质量",
    });
    return { score: 0, items };
  }

  // 通过持仓 id 找到对应的原始订单（下单类型）
  const orderByPosition = new Map<string, ReplayOrder>();
  for (const o of orders) {
    if (o.reduceOnly || !o.positionId) continue;
    orderByPosition.set(o.positionId, o);
  }

  const getContext = createContextBuilder(bars, (barIndex) => barIndex);

  let sum = 0;
  for (const t of trades) {
    const order = orderByPosition.get(t.positionId);
    const ctx = getContext(t.entryBar);
    const fillBar = bars[t.entryBar];
    const result = evaluateEntryQuality(
      bars.slice(0, t.entryBar + 1),
      {
        side: t.side,
        entryPrice: t.entryPrice,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        orderType: order?.type ?? "market",
        fillBar,
        tradeSeq: t.seq,
      },
      ctx
    );
    t.entryScore = result.score;
    t.entryDeductions = result.deductions;
    items.push(...result.deductions);
    sum += result.score;
  }

  return { score: clamp(sum / trades.length, 0, 100), items };
}

/** 风控纪律（权重 30%） */
export function scoreDiscipline(
  trades: ReplayTrade[],
  account: ReplayAccount,
  cfg: ReplayConfig
): { score: number; items: ScoreItem[] } {
  const items: ScoreItem[] = [];

  const equity = account.equity > 0 ? account.equity : account.initialCapital;

  // 1. 未设置止损（每笔 -20，最多 -40）
  let noSlCount = 0;
  for (const t of trades) {
    if (t.stopLoss == null) {
      noSlCount += 1;
      items.push({
        label: "未设置止损",
        points: -20,
        detail: `#${t.seq} ${t.side === "buy" ? "多单" : "空单"} 开仓时没有设置止损`,
        tradeSeq: t.seq,
      });
    }
  }
  if (noSlCount > 2) {
    items.push({
      label: "未设置止损（超出上限）",
      points: -(noSlCount - 2) * 20,
      detail: `共有 ${noSlCount} 笔交易未设置止损，超过 2 笔的部分按上限计扣`,
    });
  }

  // 2. 单笔风险超过上限（每笔 -15，最多 -30）
  let riskCount = 0;
  for (const t of trades) {
    if (t.stopLoss == null) continue;
    const riskValue = Math.abs(t.entryPrice - t.stopLoss) * t.quantity;
    const riskPct = (riskValue / equity) * 100;
    if (riskPct > cfg.maxRiskPerTradePct) {
      riskCount += 1;
      items.push({
        label: "单笔风险超限",
        points: -15,
        detail: `#${t.seq} 单笔风险 ${riskPct.toFixed(2)}% > 上限 ${cfg.maxRiskPerTradePct}%`,
        tradeSeq: t.seq,
      });
    }
  }
  if (riskCount > 2) {
    items.push({
      label: "单笔风险超限（超出上限）",
      points: -(riskCount - 2) * 15,
      detail: `共有 ${riskCount} 笔交易单笔风险超限，超过 2 笔的部分按上限计扣`,
    });
  }

  // 3. 手动平仓亏损超过上限（每笔 -15，最多 -30）
  let manualLossCount = 0;
  for (const t of trades) {
    if (t.exitReason === "manual" && Math.abs(t.pnlPct) > cfg.maxStopLossPct) {
      manualLossCount += 1;
      items.push({
        label: "手动平仓亏损过大",
        points: -15,
        detail: `#${t.seq} 手动平仓亏损 ${t.pnlPct.toFixed(2)}% > 上限 ${cfg.maxStopLossPct}%`,
        tradeSeq: t.seq,
      });
    }
  }
  if (manualLossCount > 2) {
    items.push({
      label: "手动平仓亏损过大（超出上限）",
      points: -(manualLossCount - 2) * 15,
      detail: `共有 ${manualLossCount} 笔手动平仓亏损超限，超过 2 笔的部分按上限计扣`,
    });
  }

  // 4. 并发持仓统计
  const overlapsOf = (t: ReplayTrade) =>
    trades.filter(
      (o) => o !== t && o.entryBar <= (t.exitBar ?? t.entryBar) && t.entryBar <= (o.exitBar ?? o.entryBar)
    );
  let maxConcurrent = 0;
  let sameSidePeak = 0;
  for (const t of trades) {
    const others = overlapsOf(t);
    maxConcurrent = Math.max(maxConcurrent, others.length + 1);
    const sameSide = others.filter((o) => o.side === t.side).length;
    sameSidePeak = Math.max(sameSidePeak, sameSide + 1);
  }

  if (maxConcurrent > cfg.maxPositions) {
    items.push({
      label: "同时持仓超限",
      points: -10,
      detail: `最多同时持有 ${maxConcurrent} 笔，超过上限 ${cfg.maxPositions}`,
    });
  }

  // 5. 同方向并发超过 3 笔（每笔 -15，最多 -30）
  if (sameSidePeak > 3) {
    const involved = trades.filter((t) => overlapsOf(t).filter((o) => o.side === t.side).length >= 3);
    involved.forEach((t) =>
      items.push({
        label: "同方向持仓过多",
        points: -15,
        detail: `#${t.seq} 同方向同时持仓 ${sameSidePeak} 笔，超过 3 笔`,
        tradeSeq: t.seq,
      })
    );
    if (involved.length > 2) {
      items.push({
        label: "同方向持仓过多（超出上限）",
        points: -(involved.length - 2) * 15,
        detail: `共有 ${involved.length} 笔涉及同方向并发过多，超过 2 笔的部分按上限计扣`,
      });
    }
  }

  // 6. 加仓（与已有未平仓同方向重复开仓）（每笔 -10，最多 -20）
  let addOnCount = 0;
  for (const t of trades) {
    if (overlapsOf(t).some((o) => o.side === t.side)) {
      addOnCount += 1;
      items.push({
        label: "同方向加仓",
        points: -10,
        detail: `#${t.seq} 开仓时已有同方向未平仓位`,
        tradeSeq: t.seq,
      });
    }
  }
  if (addOnCount > 2) {
    items.push({
      label: "同方向加仓（超出上限）",
      points: -(addOnCount - 2) * 10,
      detail: `共有 ${addOnCount} 笔同方向加仓，超过 2 笔的部分按上限计扣`,
    });
  }

  // 7. 设了止损但未设止盈（每笔 -10，最多 -20）
  let noTpCount = 0;
  for (const t of trades) {
    if (t.stopLoss != null && t.takeProfit == null) {
      noTpCount += 1;
      items.push({
        label: "未设置止盈",
        points: -10,
        detail: `#${t.seq} 设置了止损但没有设置止盈`,
        tradeSeq: t.seq,
      });
    }
  }
  if (noTpCount > 2) {
    items.push({
      label: "未设置止盈（超出上限）",
      points: -(noTpCount - 2) * 10,
      detail: `共有 ${noTpCount} 笔未设置止盈，超过 2 笔的部分按上限计扣`,
    });
  }

  // 8. 保证金占用超限
  if (account.marginUsagePct > cfg.maxMarginUsagePct) {
    items.push({
      label: "保证金占用超限",
      points: -20,
      detail: `保证金占用 ${account.marginUsagePct.toFixed(1)}% > 上限 ${cfg.maxMarginUsagePct}%`,
    });
  }

  // 9. 最大回撤超限
  if (account.maxDrawdownPct > cfg.maxDrawdownPct) {
    items.push({
      label: "最大回撤超限",
      points: -20,
      detail: `最大回撤 ${account.maxDrawdownPct.toFixed(2)}% > 上限 ${cfg.maxDrawdownPct}%`,
    });
  }

  const total = items.reduce((s, i) => s + i.points, 0);
  return { score: clamp(100 + total, 0, 100), items };
}

/** 计算整场成绩单 */
export function buildScore(
  trades: ReplayTrade[],
  account: ReplayAccount,
  cfg: ReplayConfig,
  bars: Candle[],
  orders: ReplayOrder[]
): ReplayScore {
  const profit = scoreProfit(trades, account);
  const entry = scoreEntry(trades, bars, orders);
  const discipline = scoreDiscipline(trades, account, cfg);

  // 纪律扣分同时写回每笔交易，便于逐笔展示
  const bySeq = new Map<number, ScoreItem[]>();
  for (const item of discipline.items) {
    if (item.tradeSeq == null) continue;
    const arr = bySeq.get(item.tradeSeq) ?? [];
    arr.push(item);
    bySeq.set(item.tradeSeq, arr);
  }
  for (const t of trades) {
    t.disciplineFlags = bySeq.get(t.seq) ?? [];
  }

  const sections: ReplayScoreSection[] = [
    { key: "profit", title: "盈利能力", score: Math.round(profit.score), weight: 0.4, items: profit.items },
    { key: "entry", title: "进场位置质量", score: Math.round(entry.score), weight: 0.3, items: entry.items },
    { key: "discipline", title: "风控纪律", score: Math.round(discipline.score), weight: 0.3, items: discipline.items },
  ];

  const total = sections.reduce((s, sec) => s + sec.score * sec.weight, 0);
  const rounded = Math.round(total);
  return { total: rounded, grade: gradeOf(rounded), sections };
}
