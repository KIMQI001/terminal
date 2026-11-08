import { Candle } from "@/types/chart";

/**
 * 价格带(Price Band)
 *
 * 概念:以**当前价格**为中心,从月K 线里找出上方 5 个阻力价位、下方 5 个支撑价位,
 * 每个价位再向外扩 ±halfWidth 点,形成一条 width = 2 * halfWidth 的价格带。
 *
 * 候选价位的源头(每根月K):
 *  - open / close —— 全部收录(K 线的起止价)
 *  - 阴K(close < open)的 low  —— 破位下沿
 *  - 阳K(close > open)的 high —— 突破上沿
 *  - 十字星(open == close)不额外收录 high / low
 */

/** 单个候选价位的来源类型 */
export type PriceLevelKind = "open" | "close" | "low" | "high";

/** 一个价位簇(去重后的价位) */
export interface PriceBandLevel {
  /** 代表价位(簇内按出现次数加权平均) */
  price: number;
  /** 价格带下沿 */
  lower: number;
  /** 价格带上沿 */
  upper: number;
  /** 该价位被月K 触及的次数(簇内条目数) */
  touches: number;
  /** 簇内涉及的来源类型 */
  kinds: PriceLevelKind[];
  /** 贡献该价位的月K 时间戳(秒) */
  times: number[];
}

export type PriceBandSide = "resistance" | "support";

export interface PriceBand {
  /** 计算时的当前价格 */
  currentPrice: number;
  /** 上方阻力带 —— 升序,离现价最近 → 最远 */
  resistances: PriceBandLevel[];
  /** 下方支撑带 —— 降序,离现价最近 → 最远 */
  supports: PriceBandLevel[];
  /** 每条带的宽度(点) */
  width: number;
}

export interface PriceBandOptions {
  /** 每个价位向外扩展的点数(单边),默认 200 → 带宽 400 点 */
  halfWidth?: number;
  /** 取几个阻力 / 支撑,默认 5 */
  count?: number;
  /** 价位合并容差(相对当前价),默认 0.001 = 0.1% */
  mergeTolerance?: number;
}

const DEFAULT_HALF_WIDTH = 200;
const DEFAULT_COUNT = 5;
const DEFAULT_MERGE_TOLERANCE = 0.001;

/** 单个候选价位(未去重) */
interface PriceCandidate {
  price: number;
  kind: PriceLevelKind;
  time: number;
}

const isValidPrice = (p: unknown): p is number =>
  typeof p === "number" && Number.isFinite(p) && p > 0;

/**
 * 收集月K 的候选价位。
 *
 * 规则:
 *  - open / close 全部收录
 *  - 阴K(close < open)额外收录 low
 *  - 阳K(close > open)额外收录 high
 *  - 十字星(open == close)不额外收录 high / low
 */
export function collectPriceCandidates(candles: Candle[]): PriceCandidate[] {
  const out: PriceCandidate[] = [];
  for (const c of candles) {
    if (!isValidPrice(c.open) || !isValidPrice(c.close)) continue;
    out.push({ price: c.open, kind: "open", time: c.time });
    out.push({ price: c.close, kind: "close", time: c.time });
    if (c.close < c.open) {
      if (isValidPrice(c.low)) out.push({ price: c.low, kind: "low", time: c.time });
    } else if (c.close > c.open) {
      if (isValidPrice(c.high)) out.push({ price: c.high, kind: "high", time: c.time });
    }
  }
  return out;
}

interface PriceCluster {
  price: number;
  touches: number;
  kinds: PriceLevelKind[];
  times: number[];
}

/**
 * 把候选价位按容差合并成簇(同一价位的多次触及视为一个价位)。
 *
 * 合并方式:升序扫描,新簇的起点为第一个未归簇的价位,
 * 后续价位与**簇起点**的差值 <= tol 时归入该簇(固定窗口,避免链式扩散)。
 * 代表价 = 簇内按出现次数加权平均(同一价位被多次触及权重更高)。
 */
export function mergePriceLevels(
  candidates: PriceCandidate[],
  tolerance: number
): PriceCluster[] {
  if (candidates.length === 0) return [];
  const sorted = [...candidates].sort((a, b) => a.price - b.price);

  const clusters: PriceCluster[] = [];
  let bucket: Map<number, { count: number; kinds: PriceLevelKind[]; times: number[] }> = new Map();
  let anchor = 0;

  const flush = () => {
    if (bucket.size === 0) return;
    let sum = 0;
    let count = 0;
    const kinds = new Set<PriceLevelKind>();
    const times: number[] = [];
    for (const [price, info] of bucket) {
      sum += price * info.count;
      count += info.count;
      info.kinds.forEach((k) => kinds.add(k));
      times.push(...info.times);
    }
    clusters.push({ price: sum / count, touches: count, kinds: [...kinds], times });
    bucket = new Map();
  };

  for (const cand of sorted) {
    if (cand.price - anchor > tolerance) {
      flush();
      anchor = cand.price;
    }
    const prev = bucket.get(cand.price);
    if (prev) {
      prev.count += 1;
      prev.kinds.push(cand.kind);
      prev.times.push(cand.time);
    } else {
      bucket.set(cand.price, { count: 1, kinds: [cand.kind], times: [cand.time] });
    }
  }
  flush();
  return clusters;
}

/**
 * 计算价格带。
 *
 * @param candles 月K 线数据(升序)
 * @param currentPrice 当前价格
 */
export function computePriceBand(
  candles: Candle[],
  currentPrice: number,
  options: PriceBandOptions = {}
): PriceBand {
  const halfWidth = options.halfWidth ?? DEFAULT_HALF_WIDTH;
  const count = options.count ?? DEFAULT_COUNT;
  const relTol = options.mergeTolerance ?? DEFAULT_MERGE_TOLERANCE;

  const empty: PriceBand = {
    currentPrice,
    resistances: [],
    supports: [],
    width: halfWidth * 2,
  };
  if (!isValidPrice(currentPrice) || candles.length === 0) return empty;

  const tolerance = currentPrice * relTol;
  const clusters = mergePriceLevels(collectPriceCandidates(candles), tolerance);

  const toLevel = (cl: PriceCluster): PriceBandLevel => ({
    price: cl.price,
    lower: cl.price - halfWidth,
    upper: cl.price + halfWidth,
    touches: cl.touches,
    kinds: cl.kinds,
    times: cl.times,
  });

  // 现价之上的簇 = 阻力,升序(最近的在前);现价之下的簇 = 支撑,降序(最近的在前)
  const resistances = clusters
    .filter((cl) => cl.price > currentPrice)
    .sort((a, b) => a.price - b.price)
    .slice(0, count)
    .map(toLevel);

  const supports = clusters
    .filter((cl) => cl.price < currentPrice)
    .sort((a, b) => b.price - a.price)
    .slice(0, count)
    .map(toLevel);

  return { currentPrice, resistances, supports, width: halfWidth * 2 };
}
