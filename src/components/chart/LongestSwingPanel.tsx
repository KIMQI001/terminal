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
 *   HH 射线 → 第一根**阳线**的收盘价(做多触发);LL 射线 → 第一根**阴线**的收盘价(做空触发)。
 * - 点击起点/终点/触发价位 → 预填下单,同「日K锚点」面板。
 */

import { useMemo, useState } from "react";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore } from "@/stores/orderStore";
import { Candle, SwingPoint } from "@/types/chart";
import { SWING_RAY_COUNT } from "@/lib/chart/primitives";
import { cn } from "@/lib/utils";

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
}


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
    if (match) return { candle: c, distance: pivotIdx - j };
  }
  return null;
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

/** 触发价一行:HH 下方最近阳线 C(做多) / LL 上方最近阴线 C(做空) */
function TriggerRow({
  trigger,
  side,
  pivotLabel,
  pivotPrice,
  onClick,
}: {
  trigger: TriggerCandle | null;
  side: "buy" | "sell";
  pivotLabel: string;
  pivotPrice: number;
  onClick: (price: number) => void;
}) {
  const isBuy = side === "buy";
  if (!trigger) {
    return (
      <div className="flex items-center gap-1.5 text-[9px] text-gray-400 font-mono">
        <span
          className={cn(
            "px-1 rounded leading-4 font-semibold",
            isBuy ? "bg-green-500/15 text-green-600" : "bg-red-500/15 text-red-600"
          )}
        >
          {isBuy ? "多" : "空"}
        </span>
        <span>无触发价(射线向左没扫到{pivotLabel}对应的 K 线)</span>
      </div>
    );
  }
  const { candle, distance } = trigger;
  const diffPct = pivotPrice !== 0 ? ((candle.close - pivotPrice) / pivotPrice) * 100 : 0;
  const whereText = `左${distance}根K`;
  return (
    <div className="flex items-center gap-1.5 text-[9px] font-mono">
      <span
        className={cn(
          "px-1 rounded leading-4 font-semibold",
          isBuy ? "bg-green-500/15 text-green-600" : "bg-red-500/15 text-red-600"
        )}
      >
        {isBuy ? "多" : "空"}
      </span>
      <button
        onClick={() => onClick(candle.close)}
        className="font-semibold hover:underline cursor-pointer"
        title={`${pivotLabel}射线向左扫到的第一根${isBuy ? "阳线" : "阴线"}的收盘价 —— 点击预填${isBuy ? "做多" : "做空"}`}
      >
        {isBuy ? "阳C" : "阴C"} {candle.close.toFixed(1)}
      </button>
      <span className="text-gray-400">
        {pivotLabel}射线 {whereText} {diffPct > 0 ? "+" : ""}
        {diffPct.toFixed(2)}% · {formatTime(candle.time)}
      </span>
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
            side="buy"
            pivotLabel="HH"
            pivotPrice={triggers.hhPrice}
            onClick={(p) => onPriceClick(p, "buy")}
          />
          <TriggerRow
            trigger={triggers.aboveLL}
            side="sell"
            pivotLabel="LL"
            pivotPrice={triggers.llPrice}
            onClick={(p) => onPriceClick(p, "sell")}
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
  //   HH 下方最近的阳线 C(做多触发)/ LL 上方最近的阴线 C(做空触发)
  const triggers = useMemo(() => {
    if (!maxAmplitudeLeg) return null;
    const hh = maxAmplitudeLeg.from.type === "high" ? maxAmplitudeLeg.from : maxAmplitudeLeg.to;
    const ll = maxAmplitudeLeg.from.type === "low" ? maxAmplitudeLeg.from : maxAmplitudeLeg.to;
    const hhIdx = findCandleIndex(candles, hh);
    const llIdx = findCandleIndex(candles, ll);
    return {
      hhPrice: hh.price,
      llPrice: ll.price,
      belowHH: hhIdx >= 0 ? findRayTrigger(candles, hh, hhIdx, "bullishBelow") : null,
      aboveLL: llIdx >= 0 ? findRayTrigger(candles, ll, llIdx, "bearishAbove") : null,
    };
  }, [candles, maxAmplitudeLeg]);

  const showDurationLeg =
    maxDurationLeg && maxAmplitudeLeg && maxDurationLeg !== maxAmplitudeLeg;

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
            </>
          )}
        </div>
      )}
    </div>
  );
}
