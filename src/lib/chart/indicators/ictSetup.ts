/**
 * ICT Setup 状态机
 *
 * 把散落的 ICT 指标串成一条可执行的决策链：
 *
 *   流动性池(等高/等低/前高前低)
 *     → 价格触及(影线)          → touched  (待收盘收回)
 *     → N 根内收盘收回池内      → swept    (扫荡成立)
 *     → 出现反向结构位移(BOS)   → displaced (位移成立)
 *     → 价格回踩 POI(OB/FVG/OTE)  → ready    (★ 可入场)
 *     → 真突破 / 超时 / POI 击穿  → invalid
 *
 * 只给信号，不下单。
 *
 * 设计说明（为什么自己实现而不用现成检测器）：
 * - `detectLiquidityZones`(liquidity.ts) 会把 `swept:true` 的池直接过滤掉，
 *   而状态机最需要的恰恰是「扫荡事件」，所以这里自己分组并保留已扫状态。
 * - `detectStructure`(structure.ts) 用的是整个数组共用的 currentTrend，
 *   且 BOS.time 是「被突破 swing 的时间」而非突破时刻，
 *   所以位移判定这里基于 swingPoints + candles 自行计算，能给出事件时刻。
 *
 * 纯函数，无 React / store 依赖，可在 Node 里直接单测。
 */

import { Candle, SwingPoint } from "@/types/chart";

/** 参数配置 */
export interface IctSetupConfig {
  /** 等高/等低分组容差（相对价格） */
  poolTolerance: number;
  /** 只看最近多少个 swing point */
  poolLookback: number;
  /** 触及后多少根 K 内收盘收回池内才算「扫荡」 */
  sweepReclaimBars: number;
  /** 扫荡后多少根 K 内出现反向位移算「位移成立」 */
  displacementBars: number;
  /** 位移后多少根 K 内没回踩 POI 就失效 */
  setupExpiryBars: number;
  /** 止损放在扫荡极值外的缓冲（相对价格） */
  stopBufferPct: number;
  /** 止损最小距离（占入场价） */
  minRiskPct: number;
  /** 找不到目标池时的兜底盈亏比 */
  fallbackRR: number;
  /** 至少多少根 K 才算有效 */
  minCandles: number;
}

/** 找扫荡附近结构位时，向前看的 K 线根数（这次回撤的局部极值） */
const LOCAL_LOOKBACK = 10;

export const DEFAULT_ICT_SETUP_CONFIG: IctSetupConfig = {  poolTolerance: 0.001, // 0.1%
  poolLookback: 40,
  sweepReclaimBars: 3,
  displacementBars: 5,
  setupExpiryBars: 30,
  stopBufferPct: 0.001, // 0.1%
  minRiskPct: 0.0015, // 0.15%
  fallbackRR: 2,
  minCandles: 30,
};

/** setup 状态 */
export type IctSetupState =
  | "watching" // 等待价格去扫池
  | "touched" // 已触及，等收盘收回
  | "swept" // 已扫荡，等反向位移
  | "displaced" // 已位移，等回踩 POI
  | "ready" // ★ 可入场
  | "invalid"; // 失效

export type IctDirection = "bullish" | "bearish";

/** 一次扫荡事件 */
export interface IctSweepEvent {
  /** 收回（确认）那根 K 的序号 */
  index: number;
  time: number;
  /** 扫荡窗口内的极值（多头 = 最低价，空头 = 最高价） */
  extreme: number;
}

/** 流动性池 */
export interface IctLiquidityPool {
  /** buy-side = 下方等低（做多的猎物）；sell-side = 上方等高（做空的猎物） */
  side: "buy-side" | "sell-side";
  level: number;
  /** 组内 swing 个数（>=2 即等高/等低） */
  strength: number;
  /** 是否等高/等低（strength >= 2） */
  isEqual: boolean;
  times: number[];
  lastSwingIndex: number;
  /** 是否被扫（影线触及并收盘收回） */
  swept: boolean;
  sweptIndex?: number;
  sweptTime?: number;
  /** 最近一次扫荡的极值 */
  sweepExtreme?: number;
  /** 全部扫荡事件（按时间升序） */
  sweeps: IctSweepEvent[];
  /** 是否被真突破（收盘持续越过池位）→ 池作废 */
  broken?: boolean;
  /** 已触及但还没收回 */
  touched?: boolean;
  /** 已触及、但确认窗口没走完（数据不够，暂时无法判定） */
  pending?: boolean;
}

/** 回踩 POI */
export interface IctPoi {
  type: "ob" | "fvg" | "ote";
  high: number;
  low: number;
  startTime: number;
}

/** 一个 setup 信号 */
export interface IctSetupSignal {
  id: string;
  direction: IctDirection;
  state: IctSetupState;
  pool: IctLiquidityPool;
  sweep?: IctSweepEvent;
  displacement?: { index: number; time: number; level: number };
  poi?: IctPoi;
  entry?: { price: number; zoneLow: number; zoneHigh: number };
  stopLoss?: number;
  targets?: { price: number; label: string }[];
  rr?: number;
  /** 状态说明 / 失效原因 */
  reason?: string;
  /** 计算时的最新价（面板用来算「离池位还差多少」） */
  currentPrice: number;
  updatedTime: number;
}

/** 池的事件状态 */
interface PoolEvent {
  touched: boolean;
  sweeps: IctSweepEvent[];
  broken: boolean;
  /** 触及了但确认窗口还没走完（数据不够，暂时无法判定） */
  pending: boolean;
}

/**
 * 主入口：算出当前（多 / 空）两个方向的 setup 状态
 *
 * @param candles - 当前周期 K 线（回放时为裁剪到游标的那一段）
 * @param swingPoints - 摆动点（需按 index 升序）
 * @param config - 参数覆盖
 */
export function buildIctSetups(
  candles: Candle[],
  swingPoints: SwingPoint[],
  config: Partial<IctSetupConfig> = {}
): IctSetupSignal[] {
  const cfg: IctSetupConfig = { ...DEFAULT_ICT_SETUP_CONFIG, ...config };
  if (candles.length < cfg.minCandles || swingPoints.length < 2) return [];

  const currentPrice = candles[candles.length - 1].close;
  const lastIndex = candles.length - 1;
  const pools = buildPools(candles, swingPoints, cfg);

  const setups: IctSetupSignal[] = [];
  for (const direction of ["bullish", "bearish"] as IctDirection[]) {
    const setup = buildOneSetup(direction, pools, candles, swingPoints, currentPrice, lastIndex, cfg);
    if (setup) setups.push(setup);
  }
  return setups;
}

// ---------------------------------------------------------------------------
// 池
// ---------------------------------------------------------------------------

/** 把价位相近的 swing 分组（与 liquidity.ts 的 groupSimilarLevels 同口径） */
function groupSimilarLevels(points: SwingPoint[], tolerance: number): SwingPoint[][] {
  const groups: SwingPoint[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue;
    const group: SwingPoint[] = [points[i]];
    used.add(i);
    for (let j = i + 1; j < points.length; j++) {
      if (used.has(j)) continue;
      const diff = Math.abs(points[i].price - points[j].price) / points[i].price;
      if (diff <= tolerance) {
        group.push(points[j]);
        used.add(j);
      }
    }
    groups.push(group);
  }
  return groups;
}

function buildPools(
  candles: Candle[],
  swingPoints: SwingPoint[],
  cfg: IctSetupConfig
): IctLiquidityPool[] {
  const recent = swingPoints.slice(-cfg.poolLookback);
  const highs = recent.filter((sp) => sp.type === "high");
  const lows = recent.filter((sp) => sp.type === "low");
  const pools: IctLiquidityPool[] = [];

  const push = (side: "buy-side" | "sell-side", group: SwingPoint[]) => {
    if (group.length === 0) return;
    const level = group.reduce((s, g) => s + g.price, 0) / group.length;
    const lastSwing = group.reduce((a, b) => (a.index >= b.index ? a : b));
    const pool: IctLiquidityPool = {
      side,
      level,
      strength: group.length,
      isEqual: group.length >= 2,
      times: group.map((g) => g.time),
      lastSwingIndex: lastSwing.index,
      swept: false,
      sweeps: [],
    };
    const ev = analyzePoolEvents(pool, candles, cfg);
    pool.touched = ev.touched;
    pool.sweeps = ev.sweeps;
    pool.swept = ev.sweeps.length > 0;
    const last = ev.sweeps[ev.sweeps.length - 1];
    if (last) {
      pool.sweptIndex = last.index;
      pool.sweptTime = last.time;
      pool.sweepExtreme = last.extreme;
    }
    pool.broken = ev.broken;
    pool.pending = ev.pending;
    pools.push(pool);
  };

  // 等高 → 上方 sell-side；等低 → 下方 buy-side
  for (const g of groupSimilarLevels(highs, cfg.poolTolerance)) push("sell-side", g);
  for (const g of groupSimilarLevels(lows, cfg.poolTolerance)) push("buy-side", g);

  return pools;
}

/**
 * 扫荡事件：影线触及 + N 根内收盘收回
 *
 * - 触及后窗口内收盘回到池内 → swept（扫荡成立），记录窗口极值
 * - 触及后收盘持续在池的另一侧（窗口走完仍没收回）→ broken（真突破，池作废）
 * - 触及了但确认窗口还没走完（数据不够）→ pending（待确认）
 *
 * 连续多根 K 都插在池里算「一次」扫荡（避免同一个池被重复计数）；
 * 同一个池可能有多次扫荡（回踩再触），全部保留 —— setup 锚定到「后面跟着位移」的那一次。
 */
function analyzePoolEvents(pool: IctLiquidityPool, candles: Candle[], cfg: IctSetupConfig): PoolEvent {
  const isSellSide = pool.side === "sell-side";
  const lastSwingTime = Math.max(...pool.times);
  const touches = (c: Candle) => (isSellSide ? c.high > pool.level : c.low < pool.level);

  let startIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time > lastSwingTime) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return { touched: false, sweeps: [], broken: false, pending: false };

  const sweeps: IctSweepEvent[] = [];

  for (let i = startIdx; i < candles.length; i++) {
    if (!touches(candles[i])) continue;

    // 连续插在池里的 K 合并成「一次」触及（同一个池被重复计数的根源）
    let touchEnd = i;
    while (touchEnd + 1 < candles.length && touches(candles[touchEnd + 1])) touchEnd++;

    // 收回确认窗口从「首次触及」那根起算：N 根内没收回 = 真突破
    const deadline = Math.min(candles.length - 1, i + cfg.sweepReclaimBars);
    const windowComplete = i + cfg.sweepReclaimBars <= candles.length - 1;
    let extreme = isSellSide ? candles[i].high : candles[i].low;
    let reclaimed = false;
    let reclaimedIdx = -1;

    for (let j = i; j <= deadline; j++) {
      const cj = candles[j];
      extreme = isSellSide ? Math.max(extreme, cj.high) : Math.min(extreme, cj.low);
      const inside = isSellSide ? cj.close < pool.level : cj.close > pool.level;
      if (inside) {
        reclaimed = true;
        reclaimedIdx = j;
        break;
      }
    }

    if (reclaimed) {
      // 极值覆盖整段触及（收回之后仍在池内的部分也算）
      for (let j = reclaimedIdx; j <= touchEnd; j++) {
        const cj = candles[j];
        extreme = isSellSide ? Math.max(extreme, cj.high) : Math.min(extreme, cj.low);
      }
      sweeps.push({ index: reclaimedIdx, time: candles[reclaimedIdx].time, extreme });
      i = touchEnd; // 跳过这段触及，避免同一个扫荡被重复计数
      continue;
    }

    // 没收回：窗口走完仍未收回 = 真突破（不是扫荡）
    if (windowComplete) {
      return { touched: true, sweeps, broken: true, pending: false };
    }
    // 窗口还没走完（数据不够）→ 待确认
    return { touched: true, sweeps, broken: false, pending: true };
  }

  return { touched: sweeps.length > 0, sweeps, broken: false, pending: false };
}

// ---------------------------------------------------------------------------
// 单方向 setup
// ---------------------------------------------------------------------------

function buildOneSetup(
  direction: IctDirection,
  pools: IctLiquidityPool[],
  candles: Candle[],
  swingPoints: SwingPoint[],
  currentPrice: number,
  lastIndex: number,
  cfg: IctSetupConfig
): IctSetupSignal | null {
  const bullish = direction === "bullish";
  // 多头 setup 的猎物在下方(buy-side)，空头在上方(sell-side)
  const wantedSide = bullish ? "buy-side" : "sell-side";
  const onRightSide = (p: IctLiquidityPool) => (bullish ? p.level < currentPrice : p.level > currentPrice);

  const sidePools = pools
    .filter((p) => p.side === wantedSide)
    .sort((a, b) => b.lastSwingIndex - a.lastSwingIndex);
  if (sidePools.length === 0) return null;

  const makeBase = (pool: IctLiquidityPool): IctSetupSignal => ({
    id: `${direction}-${pool.side}-${pool.level.toFixed(2)}`,
    direction,
    state: "watching",
    pool,
    currentPrice,
    updatedTime: candles[lastIndex].time,
  });

  // ① 先找「活着的链条」（★可入场 / 待回踩）：池由新到旧、扫荡也由新到旧。
  //    只要还有一条链走得通（入场 / 等回踩），就以它为准 —— 可执行的信号优先。
  for (const pool of sidePools) {
    if (pool.broken) continue;
    if (!onRightSide(pool)) continue; // 价格已跑到池的另一侧 → 这条链不成立
    for (let k = pool.sweeps.length - 1; k >= 0; k--) {
      const sweep = pool.sweeps[k];
      const disp = findDisplacement(sweep, candles, swingPoints, bullish, lastIndex, cfg);
      if (!disp) continue;
      const chain = buildChain(
        makeBase(pool),
        pool,
        sweep,
        disp,
        candles,
        pools,
        currentPrice,
        lastIndex,
        cfg,
        bullish
      );
      if (!chain) continue;
      if (chain.state === "invalid") continue; // 过期 / 被击穿 → 继续往前找
      return chain;
    }
  }

  // ② 没有活链条 → 说明这条链当前走到哪一步
  //    优先「链条进行中」的池（刚扫荡过、还在等位移），
  //    其次才是「等价格去扫」的池（最新的未破池）
  const lastSweepAt = (p: IctLiquidityPool) =>
    p.sweeps.length ? p.sweeps[p.sweeps.length - 1].index : -Infinity;
  const inProgress = sidePools.find(
    (p) =>
      !p.broken &&
      p.swept &&
      onRightSide(p) &&
      lastIndex - lastSweepAt(p) <= cfg.setupExpiryBars
  );
  const pool =
    inProgress ??
    sidePools.find((p) => !p.broken && onRightSide(p)) ??
    sidePools.find((p) => !p.broken) ??
    sidePools[0];
  const base = makeBase(pool);

  if (pool.broken) {
    base.state = "invalid";
    base.reason = `真突破：收盘持续越过${bullish ? "下方" : "上方"}池位 ${pool.level.toFixed(2)}，扫荡不成立（趋势延续）`;
    return base;
  }

  if (!pool.swept) {
    if (pool.pending) {
      base.state = "touched";
      base.reason = `已触及${bullish ? "下方" : "上方"}池位 ${pool.level.toFixed(2)}，等待收盘收回确认`;
    } else {
      base.state = "watching";
      base.reason = `等待价格扫掉${pool.isEqual ? "等" : "前"}${bullish ? "低" : "高"}池 ${pool.level.toFixed(2)}`;
    }
    return base;
  }

  // 已扫荡，但价格又回到池的另一侧 → 链条失效
  if (!onRightSide(pool)) {
    base.state = "invalid";
    base.reason = "价格已回到池位另一侧，扫荡后的结构不成立";
    return base;
  }

  // 已扫荡：看最近一次扫荡后面有没有位移
  const sweep = pool.sweeps[pool.sweeps.length - 1];
  const disp = findDisplacement(sweep, candles, swingPoints, bullish, lastIndex, cfg);
  if (disp) {
    const chain = buildChain(
      base,
      pool,
      sweep,
      disp,
      candles,
      pools,
      currentPrice,
      lastIndex,
      cfg,
      bullish
    );
    if (chain) return chain; // 走到这里说明链条已失效（①里没有活链条）
  }

  // 没有任何一次扫荡后面跟上位移 → 已扫荡，等待位移
  base.sweep = sweep;
  base.state = "swept";
  base.reason = "已扫荡，等待反向结构位移";
  return base;
}

/**
 * 构建一次完整链条：扫荡 → 位移 → POI → 入场 / 止损 / 目标 → 状态
 */
function buildChain(
  base: IctSetupSignal,
  pool: IctLiquidityPool,
  sweep: IctSweepEvent,
  disp: { index: number; level: number },
  candles: Candle[],
  pools: IctLiquidityPool[],
  currentPrice: number,
  lastIndex: number,
  cfg: IctSetupConfig,
  bullish: boolean
): IctSetupSignal | null {
  const out: IctSetupSignal = {
    ...base,
    state: "displaced",
    reason: "已位移，等待回踩 POI",
    sweep,
    displacement: { index: disp.index, time: candles[disp.index].time, level: disp.level },
  };

  // POI
  const poi = findPoi(candles, sweep.index, disp.index, bullish);
  if (!poi) {
    out.state = "invalid";
    out.reason = "位移后找不到 POI（OB/FVG/OTE）";
    return out;
  }
  out.poi = poi;

  // 入场（默认取 POI 中值）
  const entryPrice = (poi.high + poi.low) / 2;
  out.entry = { price: entryPrice, zoneLow: poi.low, zoneHigh: poi.high };

  // 止损：放在扫荡极值之外
  let stop = bullish
    ? Math.min(sweep.extreme, pool.level) * (1 - cfg.stopBufferPct)
    : Math.max(sweep.extreme, pool.level) * (1 + cfg.stopBufferPct);
  const riskMin = Math.abs(entryPrice) * cfg.minRiskPct;
  if (bullish && entryPrice - stop < riskMin) {
    stop = entryPrice - riskMin;
    out.reason = "止损已回退到最小距离（POI 低于扫荡极值）";
  } else if (!bullish && stop - entryPrice < riskMin) {
    stop = entryPrice + riskMin;
    out.reason = "止损已回退到最小距离（POI 高于扫荡极值）";
  }
  out.stopLoss = stop;

  // 目标：同方向最近的、尚未被扫的池；没有则用兜底 R
  const risk = Math.abs(entryPrice - stop);
  const targets = findTargets(pools, entryPrice, bullish, risk, cfg);
  out.targets = targets;
  const tp1 = targets[0]?.price;
  out.rr = tp1 !== undefined ? Math.abs(tp1 - entryPrice) / (risk || 1) : undefined;

  // 失效判定：位移后太久还没回踩 POI
  if (lastIndex - disp.index > cfg.setupExpiryBars) {
    out.state = "invalid";
    out.reason = "回踩超时：位移后未在有效窗口内回到 POI";
    return out;
  }
  // POI 被击穿（多头 = 价格跌破 POI 下沿）
  for (let j = disp.index + 1; j <= lastIndex; j++) {
    const c = candles[j];
    const pierced = bullish ? c.low < poi.low : c.high > poi.high;
    if (pierced) {
      out.state = "invalid";
      out.reason = "POI 已被击穿，setup 失效";
      return out;
    }
  }

  // 价格进入 POI → 可入场
  const inPoi = currentPrice <= poi.high && currentPrice >= poi.low;
  if (inPoi) {
    out.state = "ready";
    out.reason = "价格已进入 POI，可按规则入场";
  } else {
    const dist = bullish ? currentPrice - poi.high : poi.low - currentPrice;
    out.reason = `已位移，等待回踩 POI（还差 ${Math.abs(dist).toFixed(2)} 点）`;
  }

  return out;
}

/**
 * 找这次扫荡之后的反向位移
 *
 * 两种证据，任一成立即算位移：
 * ① **失衡(FVG)**：同向缺口是「反向位移」最直接的证据 —— 扫掉流动性后价格加速离开，
 *    中间留下的缺口就是这段位移本身（ICT 2022 的 displacement FVG）。
 * ② **结构突破**：收盘越过扫荡前的同侧结构位（前高/前低）。
 *
 * 注意：池被扫之后价格回踩再触一次很常见（那就是回踩 POI 本身），
 * 所以不能简单取「最后一次扫荡」，必须按「扫荡 → 是否有位移」配对。
 */
function findDisplacement(
  sweep: IctSweepEvent,
  candles: Candle[],
  swingPoints: SwingPoint[],
  bullish: boolean,
  lastIndex: number,
  cfg: IctSetupConfig
): { index: number; level: number } | null {
  const dispEnd = Math.min(lastIndex, sweep.index + cfg.displacementBars);

  // ① 失衡（FVG）：必须是扫荡「之后」形成的缺口 —— 扫荡前留下的缺口是进场腿的痕迹，不是位移
  for (let j = sweep.index + 2; j <= dispEnd; j++) {
    const a = candles[j - 2];
    const b = candles[j - 1];
    const c = candles[j];
    if (!a || !b || !c) continue;
    if (bullish && b.low > a.high) return { index: j, level: a.high };
    if (!bullish && b.high < a.low) return { index: j, level: a.low };
  }

  // ② 结构突破：收盘越过扫荡附近还没被突破的同侧结构位
  const structLevel = structureLevel(candles, swingPoints, sweep, bullish);
  if (structLevel === null) return null;
  for (let j = sweep.index; j <= dispEnd; j++) {
    const c = candles[j];
    const broke = bullish ? c.close > structLevel : c.close < structLevel;
    if (broke) return { index: j, level: structLevel };
  }
  return null;
}

/**
 * 扫荡附近的结构位（多头看上方阻力、空头看下方支撑）—— 价格要突破它才算位移
 *
 * 两个候选：
 * ① **局部区间极值**：扫荡前 LOCAL_LOOKBACK 根内的最高/最低（就是这次回撤的极点）。
 *    摆动点要等右侧 K 线确认，扫荡刚发生的那一刻最新的摆动点还没成形，
 *    只认摆动点会让位移迟迟检测不出来，所以以局部极值为主。
 * ② **未被突破的摆动高低点**：更大的结构位。
 *
 * 取两者中离现价最近的那个 —— 价格最先要吃掉的阻力/支撑。
 */
function structureLevel(
  candles: Candle[],
  swingPoints: SwingPoint[],
  sweep: IctSweepEvent,
  bullish: boolean
): number | null {
  const sweepClose = candles[sweep.index].close;
  const candidates: number[] = [];

  const from = Math.max(0, sweep.index - LOCAL_LOOKBACK);
  let local: number | null = null;
  for (let i = from; i < sweep.index; i++) {
    const v = bullish ? candles[i].high : candles[i].low;
    if (local === null) local = v;
    else local = bullish ? Math.max(local, v) : Math.min(local, v);
  }
  if (local !== null && (bullish ? local > sweepClose : local < sweepClose)) candidates.push(local);

  const swingLevel = prevStructureLevel(swingPoints, sweep.index, bullish, sweepClose);
  if (swingLevel !== null) candidates.push(swingLevel);

  if (candidates.length === 0) return null;
  return bullish ? Math.min(...candidates) : Math.max(...candidates);
}

/**
 * 扫荡之前最近的同侧结构位（多头看前高，空头看前低）
 *
 * 只认「扫荡发生时还没被突破」的价位：已经被价格越过的老摆动点当不了阻力/支撑，
 * 否则「突破」是假信号（价格早就站在它上面了）。
 */
function prevStructureLevel(
  swingPoints: SwingPoint[],
  sweepIdx: number,
  bullish: boolean,
  sweepClose: number
): number | null {
  const wantType = bullish ? "high" : "low";
  let best: SwingPoint | null = null;
  for (const sp of swingPoints) {
    if (sp.index >= sweepIdx) continue;
    if (sp.type !== wantType) continue;
    const stillValid = bullish ? sp.price > sweepClose : sp.price < sweepClose;
    if (!stillValid) continue;
    if (!best || sp.index > best.index) best = sp;
  }
  return best ? best.price : null;
}

// ---------------------------------------------------------------------------
// POI
// ---------------------------------------------------------------------------

/**
 * 回踩 POI，优先级：FVG（失衡）> OB（位移起点）> OTE（0.618–0.786 折返）
 */
function findPoi(candles: Candle[], sweepIdx: number, dispIdx: number, bullish: boolean): IctPoi | null {
  // ① FVG：位移腿内最后一个同向缺口
  for (let i = dispIdx; i > sweepIdx; i--) {
    const a = candles[i - 2];
    const b = candles[i - 1];
    const c = candles[i];
    if (!a || !b || !c) continue;
    if (bullish && b.low > a.high) {
      return { type: "fvg", low: a.high, high: c.low, startTime: b.time };
    }
    if (!bullish && b.high < a.low) {
      return { type: "fvg", low: c.high, high: a.low, startTime: b.time };
    }
  }

  // ② OB：位移腿的起点那根（多头 = 最低点那根，空头 = 最高点那根）
  let origin: Candle | null = null;
  for (let i = sweepIdx; i <= dispIdx; i++) {
    const c = candles[i];
    if (!origin) {
      origin = c;
      continue;
    }
    if (bullish ? c.low < origin.low : c.high > origin.high) origin = c;
  }
  if (origin) {
    return { type: "ob", low: origin.low, high: origin.high, startTime: origin.time };
  }

  // ③ OTE：位移腿的 0.618–0.786 折返区
  let legLow = Infinity;
  let legHigh = -Infinity;
  for (let i = sweepIdx; i <= dispIdx; i++) {
    legLow = Math.min(legLow, candles[i].low);
    legHigh = Math.max(legHigh, candles[i].high);
  }
  if (!isFinite(legLow) || !isFinite(legHigh) || legHigh <= legLow) return null;
  const range = legHigh - legLow;
  const oteLow = bullish ? legHigh - 0.786 * range : legLow + 0.618 * range;
  const oteHigh = bullish ? legHigh - 0.618 * range : legLow + 0.786 * range;
  return {
    type: "ote",
    low: Math.min(oteLow, oteHigh),
    high: Math.max(oteLow, oteHigh),
    startTime: candles[dispIdx].time,
  };
}

/** 目标：同方向最近的、尚未被扫的池；没有则用兜底 R */
function findTargets(
  pools: IctLiquidityPool[],
  entryPrice: number,
  bullish: boolean,
  risk: number,
  cfg: IctSetupConfig
): { price: number; label: string }[] {
  const wantSide = bullish ? "sell-side" : "buy-side";
  const above = pools
    .filter((p) => p.side === wantSide && !p.swept && !p.broken)
    .filter((p) => (bullish ? p.level > entryPrice : p.level < entryPrice))
    .sort((a, b) => (bullish ? a.level - b.level : b.level - a.level));

  // 太近的池位当目标没有意义（盈亏比 < 1），跳过它找下一个
  const MIN_R = 1;
  const usable =
    risk > 0
      ? above.filter((p) => Math.abs(p.level - entryPrice) / risk >= MIN_R)
      : above;

  const targets: { price: number; label: string }[] = [];
  const tp1 = usable[0];
  if (tp1) {
    targets.push({
      price: tp1.level,
      label: tp1.isEqual ? (bullish ? "上方等高池" : "下方等低池") : bullish ? "上方前高" : "下方前低",
    });
  }
  if (usable.length > 1) {
    targets.push({ price: usable[1].level, label: "第二目标池" });
  }
  if (targets.length === 0 && risk > 0) {
    targets.push({
      price: bullish ? entryPrice + risk * cfg.fallbackRR : entryPrice - risk * cfg.fallbackRR,
      label: `${cfg.fallbackRR}R`,
    });
  }
  return targets;
}

