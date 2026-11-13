"use client";

/**
 * 最长波段面板(替代原来的「历史日K OHLC (10天)」面板)
 *
 * - 数据源:图上的 Swing Points —— 最近 5 个 swing high(HH)+ 5 个 swing low(LL),
 *   与 Swing Rays 画在图上的那 10 条射线完全一致。
 * - 波段(leg)= 这 10 个点按时间排序后相邻的一高一低之间的行情。
 * - 主行:幅度最大的波段;副行:持续时间最长的波段(与主行不同才显示)。
 * - 触发价:幅度最大的波段里,沿 HH / LL **向左的虚射线**扫 K 线(射线 = 该价位的水平线,
 *   会扫过价格区间覆盖该价位的 K 线),从 HH / LL 左边开始取第一根:
 *   HH 射线 → 第一根**阳线**(显示 阳O / 阳H / 阳C,点击**做空**);
 *   LL 射线 → 第一根**阴线**(显示 阴O / 阴L / 阴C,点击**做多**)。
 * - 触发价是否**已触发**:从波段的 HH / LL **之后**开始,给每个价位(阳O/阳H/阳C、阴O/阴L/阴C)
 *   向右发一条水平射线,后续哪根 K 线的价格区间"遮挡"(覆盖)了它,就说明该价位**已经触发过** → 显示浅红框。
 * - 另外两行:**最新 HH** 和 **最新 LL**(图上 age=0 的那两条射线),各自用同一套射线规则
 *   找自己的关键价位(最新 HH → 阳O/阳H/阳C 做空;最新 LL → 阴O/阴L/阴C 做多),
 *   覆盖判定同样从该 pivot 之后开始。
 * - 点击起点/终点/触发价位 → 预填下单,同「日K锚点」面板。
 * - 底部「框架策略」区块:把这 6 个价位交给 Rust 服务 look-left-right 自动挂单
 *   (任一价位被触发 → 框架成立 → 给其余未触发价位挂单;止损 200 / 止盈 1000;
 *    有持仓则撤掉其余挂单只留止盈止损;下单量按余额比例)。
 * - 可见性:**仅 admin 账号**渲染(见 DailyKPanel)。
 */

import { useMemo, useState } from "react";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore } from "@/stores/orderStore";
import { Candle, SwingPoint } from "@/types/chart";
import { SWING_RAY_COUNT } from "@/lib/chart/primitives";
import { cn } from "@/lib/utils";
import { LongestSwingStrategy } from "./LongestSwingStrategy";

interface SwingLeg {
  from: SwingPoint;
  to: SwingPoint;
  /** 带符号的价格变化(终点 - 起点) */
  change: number;
  /** 带符号的涨跌幅(%) */
  percent: number;
  /** 绝对幅度(用于比较"最长") */
  amplitude: number;
  /** 跨越的 K 线根数 */
  bars: number;
  /** 时间跨度(秒) */
  durationSec: number;
  up: boolean;
  /** 起点在"最近 5 个 swing high/low"里的排名(1 = 最近) */
  fromRank: number;
  /** 终点排名 */
  toRank: number;
}

/** 触发 K 线:射线扫到的那根 K 线 */
interface TriggerCandle {
  candle: Candle;
  /** 该 K 线在 pivot 左边多少根 */
  distance: number;
  /** 该 K 线在 candles 数组里的下标(向右扫覆盖用) */
  index: number;
}

/** 某个价位是否已被后续 K 线"遮挡"(价格区间覆盖该价位) */
interface LevelCoverage {
  covered: boolean;
  /** 最早遮挡到它的 K 线时间(秒) */
  hitTime: number | null;
}

/** 价位 → 覆盖情况(键为 阳O/阳H/阳C 或 阴O/阴L/阴C) */
type CoverageMap = Record<string, LevelCoverage>;


/** 时间戳(秒) → "MM-DD HH:mm" */
function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 秒 → "3天12小时" / "12小时30分" / "45分" */
function formatDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`;
  return `${m}分`;
}

/**
 * 找到 pivot 对应的 K 线下标(按时间戳匹配,匹配不到再用 pivot.index 兜底)。
 * swing point 的 index 与 chartStore.candles 的下标是同一套(同一份数据源)。
 */
function findCandleIndex(candles: Candle[], pivot: SwingPoint): number {
  const byTime = candles.findIndex((c) => c.time === pivot.time);
  if (byTime >= 0) return byTime;
  if (pivot.index >= 0 && pivot.index < candles.length) return pivot.index;
  return -1;
}

/**
 * 沿**向左的虚射线**找触发 K 线。
 *
 * HH / LL 的射线是那条价位向左延伸的水平线,它会"扫过"价格区间覆盖该价位的 K 线。
 * 从 pivot 的**左边**开始扫(不含 HH/LL 本根),取第一根符合颜色要求的:
 * - bullishBelow: HH 射线扫到的第一根**阳线**(close > open)
 * - bearishAbove: LL 射线扫到的第一根**阴线**(close < open)
 *
 * distance = 该 K 线在 pivot 左边多少根。
 */
function findRayTrigger(
  candles: Candle[],
  pivot: SwingPoint,
  pivotIdx: number,
  kind: "bullishBelow" | "bearishAbove"
): TriggerCandle | null {
  const level = pivot.price;
  for (let j = pivotIdx - 1; j >= 0; j--) {
    const c = candles[j];
    if (!c) continue;
    // 射线没扫到这根 K(价格区间不覆盖该价位)
    if (c.low > level || c.high < level) continue;
    const bull = c.close > c.open;
    const bear = c.close < c.open;
    const match = kind === "bullishBelow" ? bull : bear;
    if (match) return { candle: c, distance: pivotIdx - j, index: j };
  }
  return null;
}

/**
 * 从**波段的 HH / LL 之后**开始,给每个价位向右发一条水平射线,
 * 看后续哪根 K 线的价格区间"遮挡"(覆盖)了它 —— 覆盖了就说明该价位**已经被触发过**。
 *
 * 例:阳线行做空,阳O 是挂单入场位;波段 HH 之后价格跌回 阳O → 该价位已被触发 → 标红框。
 */
function findLevelCoverage(
  candles: Candle[],
  fromIdx: number,
  levels: [string, number][]
): CoverageMap {
  const res: CoverageMap = {};
  for (const [label] of levels) res[label] = { covered: false, hitTime: null };
  for (let j = fromIdx + 1; j < candles.length; j++) {
    const c = candles[j];
    if (!c) continue;
    let all = true;
    for (const [label, price] of levels) {
      if (res[label].covered) continue;
      if (c.low <= price && price <= c.high) {
        res[label] = { covered: true, hitTime: c.time };
      } else {
        all = false;
      }
    }
    if (all) break;
  }
  return res;
}


/** 端点(起点/终点)按钮:色块标签 + 价位,点击预填下单 */
function EndpointButton({
  point,
  rank,
  onClick,
}: {
  point: SwingPoint;
  rank: number;
  onClick: (price: number) => void;
}) {
  const isHigh = point.type === "high";
  const label = isHigh ? "HH" : "LL";
  const realClass = point.classification ?? label;
  return (
    <button
      onClick={() => onClick(point.price)}
      className="flex items-center gap-1 hover:underline cursor-pointer"
      title={`第${rank}个${label}(实际分类 ${realClass}) 价位 ${point.price.toFixed(1)} —— 点击预填下单`}
    >
      <span
        className={cn(
          "px-1 rounded text-[9px] font-semibold leading-4",
          isHigh ? "bg-orange-500/15 text-orange-600" : "bg-sky-500/15 text-sky-600"
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "font-semibold",
          isHigh ? "text-orange-700" : "text-sky-700"
        )}
      >
        {point.price.toFixed(1)}
      </span>
    </button>
  );
}

/**
 * 触发价一块:
 * - kind = bullish(阳线)→ 阳O / 阳H / 阳C,点击后**做空**
 * - kind = bearish(阴线)→ 阴O / 阴L / 阴C,点击后**做多**
 * side 只决定标签(多/空)、颜色和预填方向,与 kind 解耦。
 */
function TriggerRow({
  trigger,
  kind,
  side,
  pivotLabel,
  pivotPrice,
  coverage,
  rayLabel,
  onClick,
}: {
  trigger: TriggerCandle | null;
  kind: "bullish" | "bearish";
  side: "buy" | "sell";
  pivotLabel: string;
  pivotPrice: number;
  coverage?: CoverageMap;
  /** 射线名称(默认用 pivotLabel,如「最新HH」/「波段HH」) */
  rayLabel?: string;
  onClick: (price: number, side: "buy" | "sell") => void;
}) {
  const ray = rayLabel ?? pivotLabel;

  const isBuy = side === "buy";
  const kindName = kind === "bullish" ? "阳线" : "阴线";
  const sideLabel = isBuy ? "多" : "空";
  const sideAction = isBuy ? "做多" : "做空";
  if (!trigger) {
    return (
      <div className="flex items-center gap-1.5 text-[9px] text-gray-400 font-mono">
        <span
          className={cn(
            "px-1 rounded leading-4 font-semibold",
            isBuy ? "bg-green-500/15 text-green-600" : "bg-red-500/15 text-red-600"
          )}
        >
          {sideLabel}
        </span>
        <span>无触发价(射线向左没扫到{pivotLabel}对应的 K 线)</span>
      </div>
    );
  }
  const { candle, distance } = trigger;
  const diffPct = pivotPrice !== 0 ? ((candle.close - pivotPrice) / pivotPrice) * 100 : 0;
  // 做空看阳线的高点(阳H),做多看阴线的低点(阴L)
  const chips: [string, number][] =
    kind === "bullish"
      ? [["阳O", candle.open], ["阳H", candle.high], ["阳C", candle.close]]
      : [["阴O", candle.open], ["阴L", candle.low], ["阴C", candle.close]];
  return (
    <div className="text-[9px] font-mono">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "px-1 rounded leading-4 font-semibold",
            isBuy ? "bg-green-500/15 text-green-600" : "bg-red-500/15 text-red-600"
          )}
        >
          {sideLabel}
        </span>
        {chips.map(([label, price]) => {
          const cov = coverage?.[label];
          const covered = !!cov?.covered;
          const tip = `${ray}射线向左扫到的第一根${kindName}的${label} —— 点击预填${sideAction}` +
            (covered
              ? `\n⚠ ${ray} 之后的 K 线已遮挡该价位(最早 ${cov?.hitTime ? formatTime(cov.hitTime) : "?"}),即已触发过`
              : `\n${ray} 之后的 K 线还没遮挡该价位,该价位还没被触发`);
          return (
            <button
              key={label}
              onClick={() => onClick(price, side)}
              className={cn(
                "font-semibold hover:underline cursor-pointer px-0.5 rounded border",
                covered
                  ? "border-red-300 bg-red-50/60 text-red-600"
                  : "border-transparent"
              )}
              title={tip}
            >
              {label} {price.toFixed(1)}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 pl-0.5 mt-px text-gray-400">
        <span>
          {ray}射线 左{distance}根K {diffPct > 0 ? "+" : ""}
          {diffPct.toFixed(2)}% · {formatTime(candle.time)}
        </span>
      </div>
    </div>
  );
}

/**
 * 单个 pivot(最新 HH / 最新 LL)的展示行
 *
 * 和「一条波段」共用同一套射线逻辑:
 * - HH 射线向左扫第一根**阳线** → 阳O / 阳H / 阳C(做空)
 * - LL 射线向左扫第一根**阴线** → 阴O / 阴L / 阴C(做多)
 * 覆盖判定同样是「从该 pivot 之后开始,看后续 K 线有没有遮挡这个价位」。
 */
function PivotRow({
  pivot,
  title,
  rank,
  kind,
  side,
  trigger,
  coverage,
  rayLabel,
  onPriceClick,
}: {
  pivot: SwingPoint;
  title: string;
  rank: number;
  kind: "bullish" | "bearish";
  side: "buy" | "sell";
  trigger: TriggerCandle | null;
  coverage: CoverageMap;
  rayLabel: string;
  onPriceClick: (price: number, side?: "buy" | "sell") => void;
}) {
  return (
    <div className="rounded px-1.5 py-1 border bg-gray-50/70 border-gray-100">
      <div className="flex items-center justify-between text-[9px] text-gray-500 mb-0.5">
        <span className="font-medium text-gray-600">{title}</span>
        <span className="font-mono text-gray-400">{formatTime(pivot.time)}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] font-mono">
        <EndpointButton point={pivot} rank={rank} onClick={(p) => onPriceClick(p)} />
      </div>
      <div className="mt-1 pt-1 border-t border-dashed border-gray-200 space-y-0.5">
        <TriggerRow
          trigger={trigger}
          kind={kind}
          side={side}
          pivotLabel={pivot.type === "high" ? "HH" : "LL"}
          pivotPrice={pivot.price}
          coverage={coverage}
          rayLabel={rayLabel}
          onClick={(p, s) => onPriceClick(p, s)}
        />
      </div>
    </div>
  );
}

/** 一条波段的展示行 */
function LegRow({
  leg,
  title,
  highlight,
  triggers,
  onPriceClick,
}: {
  leg: SwingLeg;
  title: string;
  highlight?: boolean;
  triggers?: {
    belowHH: TriggerCandle | null;
    aboveLL: TriggerCandle | null;
    hhPrice: number;
    llPrice: number;
    /** HH 射线阳线行三个价位的覆盖情况 */
    bullCoverage: CoverageMap;
    /** LL 射线阴线行三个价位的覆盖情况 */
    bearCoverage: CoverageMap;
  } | null;
  onPriceClick: (price: number, side?: "buy" | "sell") => void;
}) {
  const up = leg.up;
  const dirClass = up ? "text-green-600" : "text-red-600";
  return (
    <div
      className={cn(
        "rounded px-1.5 py-1 border",
        highlight ? "bg-amber-50/70 border-amber-200" : "bg-gray-50/70 border-gray-100"
      )}
    >
      <div className="flex items-center justify-between text-[9px] text-gray-500 mb-0.5">
        <span className={cn("font-medium", highlight && "text-amber-700")}>{title}</span>
        <span className="font-mono text-gray-400">
          {leg.bars} 根K · {formatDuration(leg.durationSec)}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] font-mono">
        <EndpointButton point={leg.from} rank={leg.fromRank} onClick={(p) => onPriceClick(p)} />
        <span className={cn("text-[10px]", dirClass)}>{up ? "▲" : "▼"}</span>
        <EndpointButton point={leg.to} rank={leg.toRank} onClick={(p) => onPriceClick(p)} />
        <span className={cn("ml-auto font-semibold", dirClass)}>
          {leg.change > 0 ? "+" : ""}
          {leg.change.toFixed(1)}
        </span>
        <span className={cn("font-semibold", dirClass)}>
          ({leg.percent > 0 ? "+" : ""}
          {leg.percent.toFixed(2)}%)
        </span>
      </div>

      <div className="flex items-center justify-between text-[9px] text-gray-400 font-mono mt-0.5">
        <span>{formatTime(leg.from.time)}</span>
        <span>{formatTime(leg.to.time)}</span>
      </div>

      {triggers && (
        <div className="mt-1 pt-1 border-t border-dashed border-gray-200 space-y-0.5">
          <TriggerRow
            trigger={triggers.belowHH}
            kind="bullish"
            side="sell"
            pivotLabel="HH"
            pivotPrice={triggers.hhPrice}
            coverage={triggers.bullCoverage}
            onClick={(p, s) => onPriceClick(p, s)}
          />
          <TriggerRow
            trigger={triggers.aboveLL}
            kind="bearish"
            side="buy"
            pivotLabel="LL"
            pivotPrice={triggers.llPrice}
            coverage={triggers.bearCoverage}
            onClick={(p, s) => onPriceClick(p, s)}
          />
        </div>
      )}
    </div>
  );
}

export function LongestSwingPanel() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const swingPoints = useIndicatorStore((s) => s.swingPoints);
  const { candles, timeframe } = useChartStore();
  const { setPrefillData, openModal } = useOrderStore();
  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;

  // 从 10 个 swing point(5 高 + 5 低)里切出所有波段(相邻的一高一低)
  const legs = useMemo(() => {
    const highs = swingPoints.filter((sp) => sp.type === "high");
    const lows = swingPoints.filter((sp) => sp.type === "low");
    const takeRecent = (arr: SwingPoint[]) =>
      arr.slice(Math.max(0, arr.length - SWING_RAY_COUNT));

    const recentHighs = takeRecent(highs);
    const recentLows = takeRecent(lows);

    // 排名:1 = 最近的那个(与图上射线 age=0 对应)
    const rankOf = (sp: SwingPoint) => {
      const arr = sp.type === "high" ? recentHighs : recentLows;
      const idx = arr.indexOf(sp);
      return idx >= 0 ? arr.length - idx : 0;
    };

    const points = [...recentHighs, ...recentLows].sort((a, b) => a.time - b.time);

    const result: SwingLeg[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i];
      const to = points[i + 1];
      if (from.type === to.type) continue; // 同类型相邻,不是波段
      const change = to.price - from.price;
      result.push({
        from,
        to,
        change,
        percent: from.price !== 0 ? (change / from.price) * 100 : 0,
        amplitude: Math.abs(change),
        bars: Math.max(0, to.index - from.index),
        durationSec: Math.max(0, to.time - from.time),
        up: change > 0,
        fromRank: rankOf(from),
        toRank: rankOf(to),
      });
    }
    return result;
  }, [swingPoints]);

  // 最新的 swing high / swing low(rank = 1,对应图上 age=0 的那条射线)
  const latestHigh = useMemo(() => {
    const highs = swingPoints.filter((sp) => sp.type === "high");
    return highs.length > 0 ? highs[highs.length - 1] : null;
  }, [swingPoints]);

  const latestLow = useMemo(() => {
    const lows = swingPoints.filter((sp) => sp.type === "low");
    return lows.length > 0 ? lows[lows.length - 1] : null;
  }, [swingPoints]);

  // 幅度最大的波段(用户要的"最长的波段")
  const maxAmplitudeLeg = useMemo(() => {
    if (legs.length === 0) return null;
    return legs.reduce((best, l) => (l.amplitude > best.amplitude ? l : best), legs[0]);
  }, [legs]);

  // 持续时间最长的波段(副行)
  const maxDurationLeg = useMemo(() => {
    if (legs.length === 0) return null;
    return legs.reduce((best, l) => (l.durationSec > best.durationSec ? l : best), legs[0]);
  }, [legs]);

  // 点击价位 → 预填下单(高于现价做空,低于现价做多;触发价按多/空方向指定)
  const handlePriceClick = (price: number, side?: "buy" | "sell") => {
    if (currentPrice <= 0 || price <= 0) return;
    const orderSide: "buy" | "sell" = side ?? (price >= currentPrice ? "sell" : "buy");
    const slOffset = orderSide === "buy" ? -200 : 200;
    const tpOffset = orderSide === "buy" ? 1000 : -1000;
    setPrefillData({
      side: orderSide,
      entry: price,
      stopLoss: price + slOffset,
      takeProfit: price + tpOffset,
    });
    openModal();
  };

  // 幅度最大波段的两个触发价:
  //   HH 射线向左第一根阳线(阳O/阳H/阳C,做空)/ LL 射线向左第一根阴线(阴O/阴L/阴C,做多)
  const triggers = useMemo(() => {
    if (!maxAmplitudeLeg) return null;
    const hh = maxAmplitudeLeg.from.type === "high" ? maxAmplitudeLeg.from : maxAmplitudeLeg.to;
    const ll = maxAmplitudeLeg.from.type === "low" ? maxAmplitudeLeg.from : maxAmplitudeLeg.to;
    const hhIdx = findCandleIndex(candles, hh);
    const llIdx = findCandleIndex(candles, ll);
    const belowHH = hhIdx >= 0 ? findRayTrigger(candles, hh, hhIdx, "bullishBelow") : null;
    const aboveLL = llIdx >= 0 ? findRayTrigger(candles, ll, llIdx, "bearishAbove") : null;
    // 向右射线:从波段的 HH / LL **之后**开始算,这些价位有没有被后续 K 线遮挡(=已经被触发过)
    const bullCoverage = belowHH && hhIdx >= 0
      ? findLevelCoverage(candles, hhIdx, [
          ["阳O", belowHH.candle.open],
          ["阳H", belowHH.candle.high],
          ["阳C", belowHH.candle.close],
        ])
      : {};
    const bearCoverage = aboveLL && llIdx >= 0
      ? findLevelCoverage(candles, llIdx, [
          ["阴O", aboveLL.candle.open],
          ["阴L", aboveLL.candle.low],
          ["阴C", aboveLL.candle.close],
        ])
      : {};
    return {
      hhPrice: hh.price,
      llPrice: ll.price,
      belowHH,
      aboveLL,
      bullCoverage,
      bearCoverage,
    };
  }, [candles, maxAmplitudeLeg]);

  const showDurationLeg =
    maxDurationLeg && maxAmplitudeLeg && maxDurationLeg !== maxAmplitudeLeg;

  // 最新 HH / 最新 LL 各自的射线触发价 + 覆盖情况
  //   HH 射线向左第一根阳线(阳O/阳H/阳C,做空)
  //   LL 射线向左第一根阴线(阴O/阴L/阴C,做多)
  const latestTriggers = useMemo(() => {
    const build = (
      pivot: SwingPoint | null,
      kind: "bullishBelow" | "bearishAbove"
    ): { trigger: TriggerCandle | null; coverage: CoverageMap } | null => {
      if (!pivot) return null;
      const idx = findCandleIndex(candles, pivot);
      if (idx < 0) return { trigger: null, coverage: {} };
      const trigger = findRayTrigger(candles, pivot, idx, kind);
      const coverage: CoverageMap = trigger
        ? findLevelCoverage(
            candles,
            idx,
            kind === "bullishBelow"
              ? [
                  ["阳O", trigger.candle.open],
                  ["阳H", trigger.candle.high],
                  ["阳C", trigger.candle.close],
                ]
              : [
                  ["阴O", trigger.candle.open],
                  ["阴L", trigger.candle.low],
                  ["阴C", trigger.candle.close],
                ]
          )
        : {};
      return { trigger, coverage };
    };
    return {
      high: build(latestHigh, "bullishBelow"),
      low: build(latestLow, "bearishAbove"),
    };
  }, [candles, latestHigh, latestLow]);

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg">
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="text-xs font-semibold text-gray-600">
          最长波段
          <span className="ml-1.5 text-[10px] font-normal text-gray-400">· {timeframe}</span>
        </span>
        <span className="text-gray-400 text-[10px]">{isCollapsed ? "▶" : "▼"}</span>
      </div>

      {!isCollapsed && (
        <div className="px-2 py-2 min-w-[260px] space-y-1">
          {!maxAmplitudeLeg ? (
            <div className="text-[9px] text-gray-400 py-1">等待 swing point…</div>
          ) : (
            <>
              <LegRow
                leg={maxAmplitudeLeg}
                title="幅度最大"
                highlight
                triggers={triggers}
                onPriceClick={handlePriceClick}
              />
              {showDurationLeg && maxDurationLeg && (
                <LegRow
                  leg={maxDurationLeg}
                  title="持续最久"
                  onPriceClick={handlePriceClick}
                />
              )}
              {latestHigh && latestTriggers?.high && (
                <PivotRow
                  pivot={latestHigh}
                  title="最新 HH"
                  rank={1}
                  kind="bullish"
                  side="sell"
                  trigger={latestTriggers.high.trigger}
                  coverage={latestTriggers.high.coverage}
                  rayLabel="最新HH"
                  onPriceClick={handlePriceClick}
                />
              )}
              {latestLow && latestTriggers?.low && (
                <PivotRow
                  pivot={latestLow}
                  title="最新 LL"
                  rank={1}
                  kind="bearish"
                  side="buy"
                  trigger={latestTriggers.low.trigger}
                  coverage={latestTriggers.low.coverage}
                  rayLabel="最新LL"
                  onPriceClick={handlePriceClick}
                />
              )}
              <div className="text-[9px] text-gray-400 pt-1 border-t border-dashed border-gray-100">
                浅红框 = 该价位在波段 HH/LL 之后被 K 线遮挡,即已经被触发过
              </div>
              <LongestSwingStrategy />
            </>
          )}
        </div>
      )}
    </div>
  );
}
