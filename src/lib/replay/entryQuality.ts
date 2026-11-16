import type { Candle } from "@/types/chart";
import { detectPivotsFull, detectClassifiedSwings } from "@/lib/chart/indicators/swingPoints";
import { detectOTEZones } from "@/lib/chart/indicators/ote";
import { detectOrderBlocks } from "@/lib/chart/indicators/orderBlocks";
import { detectFVGs } from "@/lib/chart/indicators/fvg";
import type { ReplaySide, ScoreItem } from "./types";

/**
 * 进场位置质量（0-100）
 *
 * 用「进场时刻可见的 K 线前缀」重算 ICT 结构，保证评分可复现、可追溯。
 */

export interface EntryQualityResult {
  score: number;
  deductions: ScoreItem[];
}

/** 前缀计算缓存（同一根 bar 只算一次） */
export interface EntryContext {
  zonePrices: { low: number; high: number }[];
  pivotPrices: number[];
  /** 最近摆动结构方向：1=偏多, -1=偏空, 0=不明确 */
  structure: 1 | -1 | 0;
}

function buildContext(prefix: Candle[]): EntryContext {
  const empty: EntryContext = { zonePrices: [], pivotPrices: [], structure: 0 };
  // 各检测器对 K 线数量有下限要求，数量不足时跳过（不做无依据的扣分）
  if (prefix.length < 10) return empty;

  const last = prefix[prefix.length - 1];
  const currentPrice = last ? last.close : 0;
  const pivotLen = Math.max(2, Math.min(20, Math.floor(prefix.length / 3)));

  const zonePrices: { low: number; high: number }[] = [];
  let pivots: { type: "high" | "low"; price: number; time: number; index: number }[] = [];
  let structure: 1 | -1 | 0 = 0;

  try {
    pivots = detectPivotsFull(prefix, pivotLen).pivots;

    const classified = detectClassifiedSwings(prefix, 2, 2, 0.5);
    const lastSwing = classified.length > 0 ? classified[classified.length - 1] : null;
    if (lastSwing) {
      if (lastSwing.classification === "HH" || lastSwing.classification === "HL") structure = 1;
      else if (lastSwing.classification === "LH" || lastSwing.classification === "LL") structure = -1;
    }

    if (pivots.length >= 2) {
      for (const z of detectOTEZones(pivots, currentPrice, prefix, 3)) {
        zonePrices.push({ low: Math.min(z.fib618, z.fib786), high: Math.max(z.fib618, z.fib786) });
      }
    }
    if (prefix.length >= 25) {
      for (const ob of detectOrderBlocks(prefix, 10, 3, 3, false)) {
        zonePrices.push({ low: ob.low, high: ob.high });
      }
    }
    for (const f of detectFVGs(prefix, { minGapPercent: 0.01 })) {
      zonePrices.push({ low: f.low, high: f.high });
    }
  } catch {
    // 检测器对数据量有要求，异常时按「无关注区」处理
    return { zonePrices: [], pivotPrices: pivots.map((p) => p.price), structure: 0 };
  }

  return {
    zonePrices,
    pivotPrices: pivots.map((p) => p.price),
    structure,
  };
}

/**
 * 创建前缀上下文构建器（带缓存）
 * @param bars 回放窗口的 K 线
 * @param prefixKeyOf 由 bar 下标算出前缀 key（同一前缀只算一次）
 */
export function createContextBuilder(
  bars: Candle[],
  prefixKeyOf: (barIndex: number) => number
): (barIndex: number) => EntryContext {
  const cache = new Map<number, EntryContext>();
  return (barIndex: number): EntryContext => {
    const key = prefixKeyOf(barIndex);
    const hit = cache.get(key);
    if (hit) return hit;
    const prefix = bars.slice(0, key + 1);
    const ctx: EntryContext =
      prefix.length > 0
        ? buildContext(prefix)
        : { zonePrices: [], pivotPrices: [], structure: 0 };
    cache.set(key, ctx);
    return ctx;
  };
}

export interface EvaluateEntryInput {
  side: ReplaySide;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  orderType: "market" | "limit";
  /** 成交的那根 K（用于判断是否追价） */
  fillBar?: Candle;
  tradeSeq?: number;
}

/**
 * 给一笔进场打分。
 * @param prefix 进场时刻可见的 K 线（含进场那根）
 */
export function evaluateEntryQuality(
  prefix: Candle[],
  input: EvaluateEntryInput,
  ctx: EntryContext
): EntryQualityResult {
  const deductions: ScoreItem[] = [];
  const { side, entryPrice, stopLoss, takeProfit, orderType, fillBar } = input;
  const seq = input.tradeSeq;

  const detailBase = seq != null ? `#${seq} ` : "";

  // 1. 是否落在 ICT 关注区
  const inZone =
    ctx.zonePrices.some((z) => entryPrice >= z.low && entryPrice <= z.high) ||
    ctx.pivotPrices.some((p) => p > 0 && Math.abs(entryPrice - p) / p <= 0.005);

  if (!inZone) {
    deductions.push({
      label: "未落在 ICT 关注区",
      points: -30,
      detail: `${detailBase}入场价 ${entryPrice} 不在 OTE / 订单块 / FVG / 摆动点附近`,
      tradeSeq: seq,
    });
  }

  // 2. 限价单成交价是否在 K 线中部（追价）
  if (orderType === "limit" && fillBar) {
    const range = fillBar.high - fillBar.low;
    if (range > 0) {
      const rel = (entryPrice - fillBar.low) / range;
      if (rel > 0.25 && rel < 0.75) {
        deductions.push({
          label: "在 K 线中部追价",
          points: -20,
          detail: `${detailBase}成交价 ${entryPrice} 位于触发 K 的中间 ${(rel * 100).toFixed(0)}%（理想位置是区间边缘）`,
          tradeSeq: seq,
        });
      }
    }
  }

  // 3. 风险回报比
  if (takeProfit == null) {
    deductions.push({
      label: "未设置止盈",
      points: -25,
      detail: `${detailBase}没有止盈，无法评估风险回报比`,
      tradeSeq: seq,
    });
  } else if (stopLoss == null) {
    deductions.push({
      label: "未设置止损",
      points: -25,
      detail: `${detailBase}没有止损，风险回报比无法评估`,
      tradeSeq: seq,
    });
  } else {
    const risk = Math.abs(entryPrice - stopLoss);
    const reward = Math.abs(takeProfit - entryPrice);
    if (risk > 0) {
      const rr = reward / risk;
      if (rr < 1.5) {
        deductions.push({
          label: "风险回报比不足",
          points: -25,
          detail: `${detailBase}RR = ${rr.toFixed(2)} < 1.5`,
          tradeSeq: seq,
        });
      }
    }
  }

  // 4. 方向与最近摆动结构相反
  if (ctx.structure !== 0) {
    const counter = (side === "buy" && ctx.structure === -1) || (side === "sell" && ctx.structure === 1);
    if (counter) {
      deductions.push({
        label: "逆势进场",
        points: -20,
        detail: `${detailBase}${side === "buy" ? "做多" : "做空"}与最近摆动结构（${ctx.structure === 1 ? "偏多" : "偏空"}）相反`,
        tradeSeq: seq,
      });
    }
  }

  const total = deductions.reduce((s, d) => s + d.points, 0);
  return { score: Math.max(0, Math.min(100, 100 + total)), deductions };
}
