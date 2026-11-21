"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  Time,
  SeriesMarker,
  IPriceLine,
  AutoscaleInfo,
} from "lightweight-charts";
import { useChartStore } from "@/stores/chartStore";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useMeasurementStore } from "@/stores/measurementStore";
import { useOrderStore, type TradingLine } from "@/stores/orderStore";
import { usePositionStore } from "@/stores/positionStore";
import { useUserStore } from "@/stores/userStore";
import { useReplayStore } from "@/stores/replayStore";
import { ReplayControlBar } from "@/components/replay/ReplayControlBar";
import { ReplayPanel } from "@/components/replay/ReplayPanel";
import { MeasurementTool } from "./MeasurementTool";
import { ICTOverlay } from "./ICTOverlay";
import { OTEPanel } from "./OTEPanel";
import { ICTSetupPanel } from "./ICTSetupPanel";
import { FVGPanel } from "./FVGPanel";
import { DailyKPanel } from "./DailyKPanel";
import { LongestSwingPanel } from "./LongestSwingPanel";
import { LiquidityGridPanel } from "./LiquidityGridPanel";
import { OBPanel } from "./OBPanel";
import { OrderCancelOverlay } from "./OrderCancelOverlay";
import { fetchKlines } from "@/lib/binance/api";
import { BinanceWebSocket } from "@/lib/binance/websocket";
import { detectSwingPoints, detectPivotsFull, detectAllPivots, classifyPivots, findLongLegSwingIndices, swingLabel, LONG_LEG_HH_COLOR, LONG_LEG_LL_COLOR } from "@/lib/chart/indicators/swingPoints";
import type { SwingLabel } from "@/lib/chart/indicators/swingPoints";
import { detectOrderBlocks } from "@/lib/chart/indicators/orderBlocks";
import { detectEngulfingPinbar } from "@/lib/chart/indicators/engulfingPinbar";
import { detectFVGs } from "@/lib/chart/indicators/fvg";
import { detectRejections } from "@/lib/chart/indicators/rejection";
import { detectProximitySignals, getProximityBandUsd, PROXIMITY_KLINE_COLOR } from "@/lib/chart/indicators/proximitySignal";
import { detectStructure } from "@/lib/chart/indicators/structure";
import { detectLiquidityZones } from "@/lib/chart/indicators/liquidity";
import { Candle } from "@/types/chart";
import type { SwingPoint } from "@/types/chart";
import {
  OrderBlockPrimitive,
  RejectionPrimitive,
  FibLevelPrimitive,
  FVGPrimitive,
  LiquidityPrimitive,
  KillzonePrimitive,
  OTEPrimitive,
  BreakerBlockPrimitive,
  LiquidationHillPrimitive,
  EquilibriumPrimitive,
  PriceBandPrimitive,
  SwingRayPrimitive,
  SWING_RAY_COUNT,
  IctSetupPrimitive,
  StructurePrimitive,
} from "@/lib/chart/primitives";
import type { SwingRay, StructureEvent, StructurePredictionEvent, SwingLeg } from "@/lib/chart/primitives";
import { computePriceBand } from "@/lib/chart/priceBand";
import { loadMonthlyCandles } from "@/lib/chart/priceBandLoader";
import { detectOTEZones } from "@/lib/chart/indicators/ote";
import { detectBreakerBlocks } from "@/lib/chart/indicators/breakerBlocks";
import { detectInducements } from "@/lib/chart/indicators/inducement";
import { detectEquilibriumZones } from "@/lib/chart/indicators/equilibrium";
import { computeInitialBalance } from "@/lib/chart/indicators/initialBalance";
import { computeAsiaBias } from "@/lib/chart/indicators/asiaBias";
import { computeEuropeBias } from "@/lib/chart/indicators/europeBias";
import { buildIctSetups } from "@/lib/chart/indicators/ictSetup";
import {
  filterVisibleItems,
  maskHiddenVolume,
  computeVisibleTimes,
  isSameTimeList,
  getStandaloneColor,
  type KlineDisplayMode,
} from "@/lib/chart/klineDisplay";
import type { ProximitySignal } from "@/types/proximitySignal";
import type { FVG, OrderBlock, StructureProjection } from "@/types/indicator";
import type { FibLevel } from "@/lib/chart/primitives";

/**
 * 回放视图常量:
 * - REPLAY_VIEW_BARS:进入回放时可见的 K 数量(≈一屏,能看清蜡烛)
 */
const REPLAY_VIEW_BARS = 150;

/**
 * 摆动点(HH/HL/LH/LL)标签配色 —— 蜡烛图 marker 与折线图 marker 共用同一套规则。
 *
 * 配色优先级:
 *  1) 长 leg 端点(相邻摆动点价差 > 1500 点) —— HH 蓝、LL 橙(优先级最高)
 *  2) HH / HL —— 绿(多头结构);LH / LL —— 红(空头结构)
 *  3) H / L(同类中的第一个,或没有分类) —— 中性灰
 */
const SWING_COLOR_BULLISH = "#22c55e";
const SWING_COLOR_BEARISH = "#ef4444";
const SWING_COLOR_NEUTRAL = "#94a3b8";

function swingLabelColor(
  label: SwingLabel,
  isLongLeg: boolean,
  type: "high" | "low"
): string {
  // 长 leg 端点配色优先(高蓝、低橙)
  if (isLongLeg) {
    return type === "high" ? LONG_LEG_HH_COLOR : LONG_LEG_LL_COLOR;
  }
  if (label === "HH" || label === "HL") return SWING_COLOR_BULLISH;
  if (label === "LH" || label === "LL") return SWING_COLOR_BEARISH;
  return SWING_COLOR_NEUTRAL;
}

/**
 * 收集 FVG/OB 的 3 档 fib 水平位(画在图上的水平虚线)。
 *
 * FVG 的档位虚线跟随 FVG 开关,OB 的档位虚线跟随 Order Blocks 开关 ——
 * 关掉哪个指标,对应的档位虚线就一起消失。
 */
function buildFibLevels(
  fvgs: FVG[],
  orderBlocks: OrderBlock[],
  withFvg: boolean,
  withOb: boolean
): FibLevel[] {
  const levels: FibLevel[] = [];

  if (withFvg) {
    for (const f of fvgs) {
      levels.push({
        time: f.time, high: f.high, low: f.low,
        type: "fvg", side: f.type, fib22: f.fib22, fib50: f.fib50, fib90: f.fib90,
      });
    }
  }

  if (withOb) {
    for (const o of orderBlocks) {
      levels.push({
        time: o.startTime, high: o.high, low: o.low,
        type: "ob", side: o.type,
        fib22: o.fib22, fib50: o.fib50 ?? o.fib22, fib90: o.fib90 ?? o.fib22,
      });
    }
  }

  return levels;
}

/**
 * 构建带颜色的蜡烛数据(Engulfing/Pinbar 染色 + Proximity Signal 染色 + 独立 K 线高亮)
 * —— 抽出成模块级函数,方便「K线显示模式」过滤后整段重建。
 *
 * 染色优先级(后者覆盖前者):
 *  1) 独立 K 线高亮 —— S 模式:独立阳k 橙色;L 模式:独立阴k 蓝色
 *  2) Engulfing Pinbar 染色
 *  3) Proximity Signal 染色
 */
function buildChartData(
  data: Candle[],
  proximitySignals: ProximitySignal[],
  mode: KlineDisplayMode = "normal"
): CandlestickData<Time>[] {
  // 先计算 Swing Points
  const pivotResult = detectPivotsFull(data, 50);
  const pinbars = detectEngulfingPinbar(data, pivotResult.pivots, 5);
  const pinbarMap = new Map(pinbars.map((p) => [p.time, p]));
  const proxMap = new Map(proximitySignals.map((s) => [s.time, s]));

  return data.map((c, i) => {
    // 独立 K 线高亮(S/L 过滤模式)
    const standaloneColor = getStandaloneColor(data, i, mode);
    if (standaloneColor) {
      return {
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        color: standaloneColor,
        borderColor: standaloneColor,
        wickColor: standaloneColor,
      };
    }

    const pinbar = pinbarMap.get(c.time);
    if (pinbar) {
      // Engulfing Pinbar 蜡烛染色
      const color = pinbar.type === "bullish" ? "#3b82f6" : "#f97316"; // 蓝=涨, 橙=跌
      return {
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        color: color,
        borderColor: color,
        wickColor: color,
      };
    }

    // Proximity Signal:触发的 K 整根染色(浅紫/深蓝)
    const proxSig = proxMap.get(c.time);
    if (proxSig) {
      const color =
        proxSig.side === "bullish"
          ? PROXIMITY_KLINE_COLOR.bullish
          : PROXIMITY_KLINE_COLOR.bearish;
      return {
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        color: color,
        borderColor: color,
        wickColor: color,
      };
    }

    return {
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    };
  });
}

/** 构建成交量数据(倍量 + 小实体 + 同色前两根 + 反转确认 → 绿/红) */
function buildVolumeData(data: Candle[]): HistogramData<Time>[] {
  return data.map((c, i) => {
    const prevVolume = i > 0 ? data[i - 1].volume ?? 0 : 0;
    const isHighVolume = prevVolume > 0 && (c.volume ?? 0) >= prevVolume * 1.9;

    // 检查后两根K线实体是否有一根小于100点（用于判断是否变色）
    const next1Body =
      i + 1 < data.length
        ? Math.abs((data[i + 1].close ?? 0) - (data[i + 1].open ?? 0))
        : 0;
    const next2Body =
      i + 2 < data.length
        ? Math.abs((data[i + 2].close ?? 0) - (data[i + 2].open ?? 0))
        : 0;
    const hasSmallBody = next1Body < 100 || next2Body < 100;

    // 检查前两根K线是否和当前K线颜色相同
    const isCurrentBullish = c.close >= c.open;
    const prev1SameColor =
      i >= 1 ? (data[i - 1].close >= data[i - 1].open) === isCurrentBullish : false;
    const prev2SameColor =
      i >= 2 ? (data[i - 2].close >= data[i - 2].open) === isCurrentBullish : false;
    const hasSameColorBefore = prev1SameColor && prev2SameColor;

    // 反转确认：第二根（i+2）的高/低不能突破倍量+第一根的范围
    // 绿柱：i+2.high ≤ max(i.high, i+1.high) —— 没突破前高，涨到头了
    // 红柱：i+2.low  ≥ min(i.low,  i+1.low)  —— 没跌破前低，跌到头了
    // 如果 i+2 不存在（最后一根附近），跳过反转确认 → 不染色
    let hasReversalConfirm = false;
    if (i + 2 < data.length) {
      const i2 = data[i + 2];
      if (isCurrentBullish) {
        hasReversalConfirm = i2.high <= Math.max(c.high, data[i + 1].high);
      } else {
        hasReversalConfirm = i2.low >= Math.min(c.low, data[i + 1].low);
      }
    }

    // 普通：阳k白色透明，阴k黑色透明
    // 倍量 + 小实体 + 同色前两根 + 反转确认：阳k绿色，阴k红色
    let color: string;
    if (isHighVolume && hasSmallBody && hasSameColorBefore && hasReversalConfirm) {
      color = c.close >= c.open ? "rgba(34, 197, 94, 0.7)" : "rgba(239, 68, 68, 0.7)";
    } else {
      color = c.close >= c.open ? "rgba(0, 0, 0, 0.2)" : "rgba(0, 0, 0, 0.4)";
    }

    return {
      time: c.time as Time,
      value: c.volume ?? 0,
      color,
    };
  });
}

export function TradingChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const highLineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lowLineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastKlineTimeRef = useRef<number>(0);
  const wsRef = useRef<BinanceWebSocket | null>(null);

  // ICT Primitives
  const orderBlockPrimitiveRef = useRef<OrderBlockPrimitive | null>(null);
  const rejectionPrimitiveRef = useRef<RejectionPrimitive | null>(null);
  const fibLevelPrimitiveRef = useRef<FibLevelPrimitive | null>(null);
  const fvgPrimitiveRef = useRef<FVGPrimitive | null>(null);
  const liquidityPrimitiveRef = useRef<LiquidityPrimitive | null>(null);
  const killzonePrimitiveRef = useRef<KillzonePrimitive | null>(null);
  const otePrimitiveRef = useRef<OTEPrimitive | null>(null);
  const ictSetupPrimitiveRef = useRef<IctSetupPrimitive | null>(null);
  const breakerBlockPrimitiveRef = useRef<BreakerBlockPrimitive | null>(null);
  const liquidationHillPrimitiveRef = useRef<LiquidationHillPrimitive | null>(null);
  const equilibriumPrimitiveRef = useRef<EquilibriumPrimitive | null>(null);
  // 价格带(Price Band):基于月K 的 5 阻力 + 5 支撑,每档 ±200 点
  const priceBandPrimitiveRef = useRef<PriceBandPrimitive | null>(null);
  // 最新 HH / LL 向左延伸的虚射线
  const swingRayPrimitiveRef = useRef<SwingRayPrimitive | null>(null);
  // 市场结构层:BOS / CHoCH 结构线 + swing leg 连线
  const structurePrimitiveRef = useRef<StructurePrimitive | null>(null);

  // Trading price lines
  const priceLinesRef = useRef<IPriceLine[]>([]);

  // 「S/L 显示模式」:锚点现价参考线 + 当前已应用的可见 K 线集合
  const anchorPriceLineRef = useRef<IPriceLine | null>(null);
  // 已应用到蜡烛序列的可见 K 线时间点(实时行情刷新时用来判断是否需要整段重建)
  const appliedVisibleTimesRef = useRef<number[]>([]);

  // 回放视图状态:是否已进入回放 + 进入回放前的可见范围(退出时还原)
  const replayViewRef = useRef<{
    inReplay: boolean;
    restore: { from: number; to: number } | null;
  }>({ inReplay: false, restore: null });

  // 「跳到最新」计数 —— 图表据此把视角重新接管回最新 K(用户主动点的)
  const jumpNonceRef = useRef<number>(-1);
  // 回放中「重新钉住最新 K」的回调 —— 图表宽度变化(右侧交易面板开合)后重新钉一次
  const replayRepinRef = useRef<(() => void) | null>(null);

  // 右侧 ICT 面板栈(盖在图上)—— 回放时要把最新 K 停在它的左边,否则会被挡住
  const rightPanelsRef = useRef<HTMLDivElement | null>(null);
  const rightInsetPx = useCallback(() => {
    const el = rightPanelsRef.current;
    if (!el) return 0;
    const w = el.getBoundingClientRect().width;
    return w > 0 ? w + 16 : 0;
  }, []);

  // Shift 键状态
  const [isShiftPressed, setIsShiftPressed] = useState(false);

  // OHLCV 显示数据
  const [ohlcvData, setOhlcvData] = useState<{ time: number; open: number; high: number; low: number; close: number; volume: number } | null>(null);

  // 月K 数据(价格带 Price Band 的计算源)
  const [monthlyCandles, setMonthlyCandles] = useState<Candle[]>([]);
  // 已绘制到 primitive 的价格带指纹(价位没变就不重复重绘)
  const priceBandKeyRef = useRef<string>("");

  const {
    symbol,
    timeframe,
    chartType,
    candles,
    liquidationData,
    dailyKAnchors,
    dailyKLineEnabled,
    displayMode,
    seriesVersion,
    setCandles,
    setChartType,
    updateCandle,
    setLoading,
    setConnected,
  } = useChartStore();

  // 回放模式:成交标记(与 swing 的 HH/LL 标记合并后一次性 setMarkers)
  const replayFills = useReplayStore((s) => s.view.fills);
  // 回放模式:持仓 / 挂单 / 表单草稿(用于画价格线)
  const replayPositions = useReplayStore((s) => s.view.positions);
  const replayOrders = useReplayStore((s) => s.view.orders);
  const replayDraft = useReplayStore((s) => s.draft);

  const {
    enabled,
    swingPoints,
    missedPivots,
    ghostLevels,
    orderBlocks,
    proximitySignals,
    fvgs,
    liquidityZones,
    ictSetups,
    ictSetupConfig,
    oteZones,
    breakerBlocks,
    equilibriumLevels,
    setSwingPoints,
    setMissedPivots,
    setGhostLevels,
    setOrderBlocks,
    setFVGs,
    setBOSSignals,
    setCHoCHSignals,
    setStructureProjection,
    bosSignals,
    chochSignals,
    structureProjection,
    setLiquidityZones,
    setIctSetups,
    setOTEZones,
    setBreakerBlocks,
    setInducements,
    setEquilibriumLevels,
    setMultiTimeframeOTE,
    setMultiTimeframeFVG,
    setMultiTimeframeOB,
    setMultiTimeframeTrend,
    setMultiTimeframeEquilibrium,
    setProximitySignals,
    setFibLevels,
    activeObFibRatio,
    setActiveObFibRatio,
    setInitialBalance,
    setAsiaBias,
    setEuropeBias,
  } = useIndicatorStore();

  const {
    phase,
    isToolActive,
    startDrawing,
    updateDrawing,
    clearMeasurement,
  } = useMeasurementStore();

  const { tradingLines, realOrders, fetchOpenOrders, setPrefillData, openModal } = useOrderStore();
  const { positions, fetchPositions } = usePositionStore();
  const { user } = useUserStore();

  // 最新的 proximitySignals(ref)—— 供 buildChartData 使用。
  // 用 ref 而不是直接依赖,避免把它放进 useEffect 依赖里导致每次都重新拉 K 线。
  const proximitySignalsRef = useRef(proximitySignals);
  proximitySignalsRef.current = proximitySignals;

  /**
   * 价格轴策略:过滤模式下把 y 轴固定在全量数据范围。
   * 这样切换 S/L 时价格轴不跳变,而且可见 K 线一定落在可视范围内(不会出现空白图)。
   */
  const applyDisplayModePriceAxis = useCallback(
    (mode: KlineDisplayMode, anchor: number | null, candlesNow: Candle[]) => {
      const series = candleSeriesRef.current;
      if (!series) return;

      if (mode === "normal" || anchor === null || candlesNow.length === 0) {
        // 恢复正常自适应(base 是库自带的自适应实现)
        series.applyOptions({
          autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => base(),
          lastValueVisible: true,
        });
        return;
      }

      let minValue = Infinity;
      let maxValue = -Infinity;
      candlesNow.forEach((c) => {
        if (c.low < minValue) minValue = c.low;
        if (c.high > maxValue) maxValue = c.high;
      });
      if (!isFinite(minValue) || !isFinite(maxValue)) return;

      series.applyOptions({
        autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
          const b = base();
          return { priceRange: { minValue, maxValue }, margins: b?.margins };
        },
        // 序列最后一条就是正在形成的实时 K(收盘价=现价),
        // 但价格轴上已经有「现价 X」锚点标签了 → 关掉重复的最后值标签
        lastValueVisible: false,
      });
    },
    []
  );

  /** 锚点现价参考线:进入 S/L 模式时画一条水平虚线,标出过滤所依据的现价 */
  const syncAnchorPriceLine = useCallback(
    (mode: KlineDisplayMode, anchor: number | null) => {
      const series = candleSeriesRef.current;
      if (!series) return;

      if (anchorPriceLineRef.current) {
        try {
          series.removePriceLine(anchorPriceLineRef.current);
        } catch {
          // 价格线已被移除,忽略
        }
        anchorPriceLineRef.current = null;
      }
      if (mode === "normal" || anchor === null) return;

      anchorPriceLineRef.current = series.createPriceLine({
        price: anchor,
        color: "#94a3b8",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `现价 ${anchor}`,
      });
    },
    []
  );

  /**
   * 按当前显示模式重建蜡烛 / 成交量 / 高低价线序列。
   * mode = normal → 全部显示;short(S) → 只留现价上方阳线;long(L) → 只留现价下方阴线。
   *
   * 关键点:
   * 1) 蜡烛 / 折线序列只放「可见」的 K 线 —— 被隐藏的 K 线直接不进序列,自然不绘制。
   * 2) 成交量序列保留**全部时间点**(隐藏 K 的成交量置 0)。成交量与蜡烛共用一条时间轴,
   *    只要时间点还在,时间轴就不会塌陷 / 重新锚定,用户的缩放与平移得以保留。
   *    (lightweight-charts v4 的 setData 会丢弃 whitespace 占位,不能靠它兜底)
   * 3) 过滤期间价格轴固定为全量数据范围,避免切换模式时 y 轴跳变或图表空白。
   */
  const buildFilteredSeries = useCallback(() => {
    if (!candleSeriesRef.current) return;

    const state = useChartStore.getState();
    const candlesNow = state.candles;
    if (candlesNow.length === 0) return;

    const mode: KlineDisplayMode = state.displayMode;
    const anchor = state.displayAnchorPrice;

    // 蜡烛序列:只放可见 K 线
    candleSeriesRef.current.setData(
      filterVisibleItems(
        buildChartData(candlesNow, proximitySignalsRef.current, mode),
        candlesNow,
        mode,
        anchor
      )
    );

    // 成交量序列:全部时间点都保留,隐藏 K 的成交量置 0(时间轴靠它兜底)
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.setData(
        maskHiddenVolume(buildVolumeData(candlesNow), candlesNow, mode, anchor)
      );
    }

    // 高低价线(折线图模式):只保留可见 K 线
    if (highLineSeriesRef.current && lowLineSeriesRef.current) {
      highLineSeriesRef.current.setData(
        filterVisibleItems(
          candlesNow.map((c) => ({ time: c.time as Time, value: c.high })),
          candlesNow,
          mode,
          anchor
        )
      );
      lowLineSeriesRef.current.setData(
        filterVisibleItems(
          candlesNow.map((c) => ({ time: c.time as Time, value: c.low })),
          candlesNow,
          mode,
          anchor
        )
      );
    }

    // 价格轴:过滤模式下固定为全量范围 + 隐藏「最后值」标签(那已是最后一根可见 K,不是现价)
    applyDisplayModePriceAxis(mode, anchor, candlesNow);

    // 锚点现价参考线
    syncAnchorPriceLine(mode, anchor);

    // 记录:当前已应用的可见 K 线集合(实时行情刷新时,只有集合变了才需要整段重建)
    appliedVisibleTimesRef.current = computeVisibleTimes(candlesNow, mode, anchor);
  }, [applyDisplayModePriceAxis, syncAnchorPriceLine]);

  // 双击图表下单:拖动价格线状态
  const [dragState, setDragState] = useState<{
    active: boolean;
    lineIdx: number;
    startY: number;
    startPrice: number;
  }>({ active: false, lineIdx: -1, startY: 0, startPrice: 0 });

  // iPad/触摸双击检测:记录上次 tap 的时间和位置(用 ref 不触发重渲染)
  const lastTapRef = useRef<{ time: number; x: number; y: number }>({
    time: 0,
    x: 0,
    y: 0,
  });

  // 监听 Shift 键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setIsShiftPressed(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setIsShiftPressed(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // 图表加载时自动获取订单和持仓（WebSocket 连接时由 WebSocket 推送更新，不需要轮询）
  useEffect(() => {
    // 首次加载时获取一次数据
    fetchOpenOrders(symbol);
    fetchPositions();
  }, [symbol]);

  // 可以开始测量的条件：Shift 按下 或 工具栏激活
  const canStartMeasure = isShiftPressed || isToolActive;

  // Calculate indicators when candles change
  // Swing point lookback 缩放：短 TF 用更少 bars，避免等 50×15min=12.5h 才确认 swing
  const getSwingLookback = (tf: string): number => {
    const lookbacks: Record<string, number> = {
      '1m': 30,   // 30 min
      '5m': 30,   // 2.5 h
      '15m': 20,  // 5 h
      '1h': 24,   // 1 d
      '4h': 30,   // 5 d
      '1d': 30,   // 1 mo
    };
    return lookbacks[tf] ?? 50;
  };

  const calculateIndicators = useCallback(
    (candleData: Candle[]) => {
      if (candleData.length < 10) return;

      const swingLength = getSwingLookback(timeframe);

      // Swing points (LuxAlgo 风格,按 TF 缩放 length)
      // detectPivotsFull 返回的 pivots 已带 HH/HL/LH/LL 分类与 confirmIndex,
      // 不再走旧的 classifyPivots 包装(它会额外做 0.5% 摆动幅度过滤并丢掉 confirmIndex)
      const pivotResult = detectPivotsFull(candleData, swingLength);
      const classifiedPivots = pivotResult.pivots;
      setSwingPoints(classifiedPivots);
      setMissedPivots(pivotResult.missedPivots);
      setGhostLevels(pivotResult.ghostLevels);

      // OB 始终计算（面板需要数据）
      const obs = detectOrderBlocks(candleData);
      setOrderBlocks(obs);
      // 保存到多周期 OB 存储（按时间排序取最新的一个）
      const targetTimeframes = ['5m', '15m', '1h', '4h', '1d'] as const;
      if (targetTimeframes.includes(timeframe as typeof targetTimeframes[number])) {
        const sortedObs = [...obs].sort((a, b) => b.startTime - a.startTime);
        setMultiTimeframeOB(timeframe, sortedObs[0] || null);
      }

      // FVG 始终计算(面板需要数据)— tier 基于 swing points
      // 注意:必须用本帧刚算出的 classifiedPivots,
      // 用 useCallback 闭包里的旧 store 值会永远慢一帧(FVG tier 全错)
      const newFvgs = detectFVGs(candleData, { swingPoints: classifiedPivots });
      setFVGs(newFvgs);
      // 保存到多周期 FVG 存储（只保存最新的一个）
      const targetTimeframes2 = ['5m', '15m', '1h', '4h', '1d'] as const;
      if (targetTimeframes2.includes(timeframe as typeof targetTimeframes2[number])) {
        setMultiTimeframeFVG(timeframe, newFvgs[newFvgs.length - 1] || null);
      }

      // BOS/CHoCH 始终计算（MTF Trend 面板需要数据）
      // 新签名:detectStructure(candles, swingPoints) —— 用带分类的摆动点做判定
      const { bos, choch, projection } = detectStructure(candleData, classifiedPivots);
      // 开关关闭时清空残留信号(最多保留 60 个 BOS / 20 个 CHoCH)
      setBOSSignals(enabled.bos ? bos.slice(-60) : []);
      setCHoCHSignals(enabled.choch ? choch.slice(-20) : []);
      // 预测目标位（上下各一个）—— 门槛外侧的下一个结构位，渲染成实线
      setStructureProjection(projection);

      // 计算并保存多周期趋势
      const targetTimeframes4 = ['5m', '15m', '1h', '4h', '1d'] as const;
      if (targetTimeframes4.includes(timeframe as typeof targetTimeframes4[number])) {
        let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
        if (choch.length > 0) {
          trend = choch[choch.length - 1].type;
        } else if (bos.length > 0) {
          trend = bos[bos.length - 1].type;
        }
        setMultiTimeframeTrend(timeframe, trend);
      }

      if (enabled.liquidityZones) {
        const zones = detectLiquidityZones(candleData, pivotResult.pivots);
        setLiquidityZones(zones);
      }

      // ICT Setup 状态机（流动性池 → 扫荡 → 位移 → 回踩 POI → 可入场）
      // 独立计算，只受 ICT Setup 开关控制，不依赖其他指标的 enabled 门控
      if (enabled.ictSetup) {
        setIctSetups(buildIctSetups(candleData, pivotResult.pivots, ictSetupConfig));
      } else {
        setIctSetups([]);
      }

      // OTE zones 始终计算（面板需要数据）
      const lastPrice = candleData[candleData.length - 1].close;
      const otes = detectOTEZones(pivotResult.pivots, lastPrice, candleData);
      setOTEZones(otes);
      // 保存到多周期 OTE 存储（只保存最新的一个）
      const targetTimeframes3 = ['5m', '15m', '1h', '4h', '1d'] as const;
      if (targetTimeframes3.includes(timeframe as typeof targetTimeframes3[number])) {
        setMultiTimeframeOTE(timeframe, otes[0] || null);
      }

      // Equilibrium 始终计算（位置过滤 + HTF 面板需要数据）
      const eqZones = detectEquilibriumZones(pivotResult.pivots, lastPrice, candleData, 2);
      setEquilibriumLevels(eqZones);
      // 保存到多周期 EQ 存储
      if (targetTimeframes3.includes(timeframe as typeof targetTimeframes3[number])) {
        const top = eqZones[0];
        setMultiTimeframeEquilibrium(
          timeframe,
          top
            ? {
                equilibrium: top.equilibrium,
                side: top.side,
                swingHigh: top.swingHigh,
                swingLow: top.swingLow,
              }
            : null
        );
      }

      // Breaker blocks (need order blocks first)
      if (enabled.breakerBlocks) {
        const obs = detectOrderBlocks(candleData); // Need all OBs including mitigated
        const breakers = detectBreakerBlocks(candleData, obs);
        setBreakerBlocks(breakers);
      }

      // Inducement
      if (enabled.inducement) {
        const inducements = detectInducements(candleData, pivotResult.pivots);
        setInducements(inducements);
      }

      // Proximity Signal(放在最后,确保 newFvgs/obs 已声明)
      if (enabled.proximitySignals) {
        const bandUsd = getProximityBandUsd();
        const proxRejections = detectRejections(candleData);
        const proxSignals = detectProximitySignals(
          candleData, newFvgs, obs, proxRejections, bandUsd
        );
        setProximitySignals(proxSignals);
      } else {
        setProximitySignals([]);
      }

      // 收集 FVG/OB 的 fib 水平位(画在图上的水平虚线)
      // FVG 档位跟随 FVG 开关,OB 档位跟随 Order Blocks 开关
      const fibLevels = buildFibLevels(newFvgs, obs, enabled.fvg, enabled.orderBlocks);
      setFibLevels(fibLevels);
      if (fibLevelPrimitiveRef.current) {
        fibLevelPrimitiveRef.current.setData(fibLevels, activeObFibRatio);
      }
    },
    [enabled, timeframe, ictSetupConfig, setSwingPoints, setMissedPivots, setGhostLevels, setOrderBlocks, setFVGs, setBOSSignals, setCHoCHSignals, setStructureProjection, setLiquidityZones, setIctSetups, setOTEZones, setBreakerBlocks, setInducements, setEquilibriumLevels, setProximitySignals, setFibLevels, setMultiTimeframeOTE, setMultiTimeframeFVG, setMultiTimeframeOB, setMultiTimeframeTrend, setMultiTimeframeEquilibrium]
  );

  // 序列数据版本号变化 → 重建序列 + 重算指标
  // 正常行情路径不会 bump(seriesVersion 恒为 0),行为完全不变;
  // 回放模式裁剪 K 线时 replayStore 会 bump,图表据此把序列换成「只到游标」的那一段。
  useEffect(() => {
    if (seriesVersion === 0) return;

    const ts = chartRef.current?.timeScale();
    const replayState = useReplayStore.getState();

    // ① 视图策略要在 buildFilteredSeries 之前判定:
    //    进入回放的那一刻,时间轴上还挂着回放前的完整数据 —— 这时抓到的可见范围
    //    才是「回放前的原视图」(setData 之后右端会被数据末尾夹断,抓不到了)。
    let restoreAfterBuild: { from: number; to: number } | null = null;
    let justEnteredReplay = false;
    if (replayState.isReplaying && !replayViewRef.current.inReplay) {
      replayViewRef.current.inReplay = true;
      justEnteredReplay = true;
      const r = ts?.getVisibleLogicalRange();
      replayViewRef.current.restore = r ? { from: r.from, to: r.to } : null;
    } else if (!replayState.isReplaying && replayViewRef.current.inReplay) {
      replayViewRef.current.inReplay = false;
      restoreAfterBuild = replayViewRef.current.restore;
      replayViewRef.current.restore = null;
    }

    buildFilteredSeries();

    const cs = useChartStore.getState();
    const slice = cs.candles;
    if (slice.length > 0) {
      calculateIndicators(slice);
    }

    const lastIndex = slice.length - 1;

    // ===== 刚退出回放 → 还原进入回放前的视图 =====
    if (restoreAfterBuild) {
      if (ts) ts.setVisibleLogicalRange(restoreAfterBuild);
      return;
    }

    // ===== 非回放:原有逻辑 =====
    if (!replayState.isReplaying) {
      replayRepinRef.current = null;
      // 视图本来贴着最右端时才跟随滚动,否则保持用户自己的平移
      if (ts) {
        const range = ts.getVisibleLogicalRange();
        if (!range || cs.candles.length - 1 - range.to < 3) {
          ts.scrollToRealTime();
        }
      }
      return;
    }

    // ===== 回放中 =====
    // 右侧被 ICT 面板栈盖住,最新回放 K 会被挡住 → 给面板栈留出空间,
    // 把最新 K 钉在「面板左边」的固定位置。
    //
    // ⚠️ 钉住之后**不再动视图**:lightweight-charts 自己会把新 K 钉在同一像素位置
    //    (rightOffset 不变 → 老 K 向左滚动、最新 K 不动),
    //    用户拖动图表时我们完全不干预 → 他拖到哪就停在哪,不会把视角拽回去。
    if (!ts) return;

    // 把「最新回放 K」钉到「面板左边」(宽度 = width - inset)
    //   x(最新K) = width - (rightOffset + 0.5) * barSpacing - 1
    // keepZoom=true 时沿用用户当前的缩放级别,只把最新 K 拉回面板左边
    // ⚠️ inset / width 都实时取 —— 图表宽度是异步生效的,不能缓存旧值
    const focusToFront = (keepZoom: boolean, lastIdx: number = lastIndex) => {
      const w = ts!.width();
      const ins = rightInsetPx();
      const usable = Math.max(w * 0.4, w - ins);
      const range = ts!.getVisibleLogicalRange();
      const curSpacing = range ? w / (range.to - range.from + 1) : 0;
      const barSpacing = keepZoom && curSpacing >= 1 ? curSpacing : usable / REPLAY_VIEW_BARS;
      const len = w / barSpacing; // 可见槽位总数(右侧留白给面板)
      const rightOffset = (ins - 1) / barSpacing - 0.5;
      const to = rightOffset + lastIdx;
      ts!.setVisibleLogicalRange({ from: to - len + 1, to });
    };

    // 图表宽度变了(右侧交易面板开合)→ 重新钉一次,保证最新 K 仍贴在面板左边
    const repin = () => {
      const cur = useChartStore.getState().candles.length - 1;
      focusToFront(false, cur);
    };
    replayRepinRef.current = repin;

    if (justEnteredReplay) {
      // 刚进入回放(原视图已在上面记下):
      //  把视图收到回放窗口末尾 —— 否则一万多根历史把回放挤成一条线,看不清最新 K
      focusToFront(false);
      jumpNonceRef.current = replayState.jumpNonce;
      return;
    }

    // 回看态(cursor < frontier):不动视图,让用户自己看历史
    if (replayState.cursor < replayState.frontier) {
      replayRepinRef.current = null;
      return;
    }

    // 用户主动点「跳到最新」→ 重新接管视角,把最新 K 钉回面板左边
    if (replayState.jumpNonce !== jumpNonceRef.current) {
      jumpNonceRef.current = replayState.jumpNonce;
      focusToFront(true);
      return;
    }
    jumpNonceRef.current = replayState.jumpNonce;

    // 其它情况(前进/播放):**完全不碰视图** ——
    //  · 用户没拖过 → 最新 K 天然停在钉住的位置,老 K 向左滚动
    //  · 用户拖过   → 他的视角原样保留,新 K 继续往右长,图表不跳动
  }, [seriesVersion, buildFilteredSeries, calculateIndicators, rightInsetPx]);

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: "#ffffff" },
        textColor: "#1a1a1a",
      },
      grid: {
        vertLines: { color: "#f0f0f0" },
        horzLines: { color: "#f0f0f0" },
      },
      crosshair: {
        mode: 0, // Normal 模式：十字星跟随鼠标，不吸附K线
        vertLine: {
          color: "#9ca3af",
          width: 1,
          style: 2,
          labelBackgroundColor: "#1a1a1a",
        },
        horzLine: {
          color: "#9ca3af",
          width: 1,
          style: 2,
          labelBackgroundColor: "#1a1a1a",
        },
      },
      leftPriceScale: {
        visible: true,
        borderColor: "#e0e0e0",
      },
      rightPriceScale: {
        visible: false,
      },
      timeScale: {
        borderColor: "#e0e0e0",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (timestamp: number) => {
          // 转换为上海时间 (UTC+8)，使用 Intl 避免夏令时问题
          const date = new Date(timestamp * 1000);
          const shanghaiTime = new Date(date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }));

          const month = String(shanghaiTime.getMonth() + 1).padStart(2, '0');
          const day = String(shanghaiTime.getDate()).padStart(2, '0');
          const hours = String(shanghaiTime.getHours()).padStart(2, '0');
          const minutes = String(shanghaiTime.getMinutes()).padStart(2, '0');

          return `${month}-${day} ${hours}:${minutes}`;
        },
      },
      localization: {
        timeFormatter: (timestamp: number) => {
          // 转换为上海时间 (UTC+8)，使用 Intl 避免夏令时问题
          const date = new Date(timestamp * 1000);
          const shanghaiTime = new Date(date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }));

          const month = String(shanghaiTime.getMonth() + 1).padStart(2, '0');
          const day = String(shanghaiTime.getDate()).padStart(2, '0');
          const hours = String(shanghaiTime.getHours()).padStart(2, '0');
          const minutes = String(shanghaiTime.getMinutes()).padStart(2, '0');

          return `${month}-${day} ${hours}:${minutes}`;
        },
      },
    });

    // 阳K：白色内部 + 黑色边框
    // 阴K：黑色内部 + 黑色边框
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#ffffff",
      downColor: "#1a1a1a",
      borderUpColor: "#1a1a1a",
      borderDownColor: "#1a1a1a",
      wickUpColor: "#1a1a1a",
      wickDownColor: "#1a1a1a",
      priceScaleId: "left",
      // 当前价格线配置 - 黑色标签
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: "#1a1a1a",
      priceLineWidth: 1,
      priceLineStyle: 2, // 虚线
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    // 开发模式下暴露图表实例(便于调试时间轴/可见范围),生产环境不暴露
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __chart?: IChartApi }).__chart = chart;
    }

    // 成交量柱状图
    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: 'volume',
    });

    // 设置成交量刻度
    chart.priceScale('volume').applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    volumeSeriesRef.current = volumeSeries;

    // 订阅十字光标移动事件以更新 OHLCV 显示
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        return;
      }
      // 从 chartStore 获取当前 candles 数据
      const candles = useChartStore.getState().candles;
      const candle = candles.find(c => c.time === (param.time as number));
      if (candle) {
        setOhlcvData({
          time: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume ?? 0,
        });
      }
    });

    // High Line Series (红色)
    const highLineSeries = chart.addLineSeries({
      color: "#ef4444",
      lineWidth: 2,
      visible: false,
    });
    highLineSeriesRef.current = highLineSeries;

    // Low Line Series (绿色)
    const lowLineSeries = chart.addLineSeries({
      color: "#22c55e",
      lineWidth: 2,
      visible: false,
    });
    lowLineSeriesRef.current = lowLineSeries;

    // Initialize ICT Primitives
    const obPrimitive = new OrderBlockPrimitive();
    const rejectionPrimitive = new RejectionPrimitive();
    const fibLevelPrimitive = new FibLevelPrimitive();
    const fvgPrimitive = new FVGPrimitive();
    const liquidityPrimitive = new LiquidityPrimitive();
    const killzonePrimitive = new KillzonePrimitive();
    const otePrimitive = new OTEPrimitive();
    const breakerBlockPrimitive = new BreakerBlockPrimitive();
    const liquidationHillPrimitive = new LiquidationHillPrimitive();
    const equilibriumPrimitive = new EquilibriumPrimitive();
    const priceBandPrimitive = new PriceBandPrimitive();
    const swingRayPrimitive = new SwingRayPrimitive();
    const ictSetupPrimitive = new IctSetupPrimitive();
    const structurePrimitive = new StructurePrimitive();

    // Attach primitives in order (bottom layer first)
    candleSeries.attachPrimitive(killzonePrimitive);
    candleSeries.attachPrimitive(equilibriumPrimitive);  // EQ 背景：在 killzone 之后、OTE 之前
    candleSeries.attachPrimitive(priceBandPrimitive);    // 价格带：最底层,不遮挡 K 线
    candleSeries.attachPrimitive(swingRayPrimitive);     // 最新 HH/LL 向左虚射线
    candleSeries.attachPrimitive(structurePrimitive);    // 市场结构：BOS / CHoCH + swing leg
    candleSeries.attachPrimitive(otePrimitive);
    candleSeries.attachPrimitive(ictSetupPrimitive); // ICT Setup：POI / 入场 / 止损 / 目标
    candleSeries.attachPrimitive(breakerBlockPrimitive);
    candleSeries.attachPrimitive(obPrimitive);
    candleSeries.attachPrimitive(fvgPrimitive);
    candleSeries.attachPrimitive(liquidityPrimitive);
    candleSeries.attachPrimitive(liquidationHillPrimitive);
    candleSeries.attachPrimitive(rejectionPrimitive);
    candleSeries.attachPrimitive(fibLevelPrimitive);

    orderBlockPrimitiveRef.current = obPrimitive;
    rejectionPrimitiveRef.current = rejectionPrimitive;
    fibLevelPrimitiveRef.current = fibLevelPrimitive;
    fvgPrimitiveRef.current = fvgPrimitive;
    liquidityPrimitiveRef.current = liquidityPrimitive;
    killzonePrimitiveRef.current = killzonePrimitive;
    otePrimitiveRef.current = otePrimitive;
    ictSetupPrimitiveRef.current = ictSetupPrimitive;
    breakerBlockPrimitiveRef.current = breakerBlockPrimitive;
    liquidationHillPrimitiveRef.current = liquidationHillPrimitive;
    equilibriumPrimitiveRef.current = equilibriumPrimitive;
    priceBandPrimitiveRef.current = priceBandPrimitive;
    swingRayPrimitiveRef.current = swingRayPrimitive;
    structurePrimitiveRef.current = structurePrimitive;

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
        // 回放中:宽度变了 → 把最新 K 重新钉到面板左边。
        // ⚠️ 图表的新宽度是异步生效的,等两帧再钉,否则会按旧宽度算位置。
        requestAnimationFrame(() => {
          requestAnimationFrame(() => replayRepinRef.current?.());
        });
      }
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    // 容器尺寸变化也要重画（例如右侧「交易」面板打开/关闭），
    // 否则 canvas 会保持旧宽度 → 右边一截被面板盖住
    let resizeObserver: ResizeObserver | null = null;
    if (chartContainerRef.current && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => handleResize());
      resizeObserver.observe(chartContainerRef.current);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
      chart.remove();
    };
  }, []);

  // Fetch data and setup polling (HTTP 轮询替代 WebSocket)
  useEffect(() => {
    // 使用标记来处理竞态条件
    let isCancelled = false;
    const currentSymbol = symbol;
    const currentTimeframe = timeframe;

    // 停止旧的轮询
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    // 清空旧数据，防止闪烁
    if (candleSeriesRef.current) {
      candleSeriesRef.current.setData([]);
    }

    // 重置价格轴为自动模式，确保新数据能正确显示
    if (chartRef.current) {
      chartRef.current.priceScale('left').applyOptions({
        autoScale: true,
      });
    }

    // 清空清算数据，防止显示旧 symbol 的数据
    useChartStore.getState().setLiquidationData(null);

    const loadData = async () => {
      setLoading(true);
      try {
        // BTC/ETH 请求 15000 根（约150天），其他交易对请求 3000 根
        const limit = (currentSymbol === "BTCUSDC" || currentSymbol === "ETHUSDC") ? 15000 : 3000;
        const data = await fetchKlines(currentSymbol, currentTimeframe, limit);

        // 检查是否已被取消（symbol/timeframe 已变化）
        if (isCancelled) {
          return;
        }

        setCandles(data);
        calculateIndicators(data);

        if (candleSeriesRef.current && chartRef.current) {
          // 应用 K 线显示模式(S/L 过滤)—— setCandles 已把锚点现价重置为新数据的最新价
          buildFilteredSeries();

          // 切换 symbol 后让图表自适应价格轴范围
          chartRef.current.timeScale().fitContent();
        }

        // 记录最后一根 K 线时间
        if (data.length > 0) {
          lastKlineTimeRef.current = data[data.length - 1].time;
        }

        setConnected(true);
        setLoading(false);
      } catch (error) {
        if (!isCancelled) {
          console.error("Failed to load klines:", error);
          setLoading(false);
        }
      }
    };

    // 轮询获取最新数据
    const startPolling = () => {
      // 计算轮询间隔（比周期多 5 秒）
      const tfMs: Record<string, number> = {
        '1m': 65000, '3m': 185000, '5m': 305000, '15m': 905000,
        '30m': 1805000, '1h': 3605000, '2h': 7205000, '4h': 14405000,
        '6h': 21605000, '8h': 28805000, '12h': 43205000,
        '1d': 86405000, '4d': 345600000, '1w': 604800000,
      };
      // 使用 WebSocket 实时更新（替换轮询）
      const ws = new BinanceWebSocket(currentSymbol, currentTimeframe, (candle, isClosed) => {
        // ★ 回放模式：屏蔽实时行情推送（回放结束后自动恢复，不重建 WS）
        if (useReplayStore.getState().isReplaying) return;

        console.log(`[TradingChart] WS K线更新: ${candle.time}, closed=${isClosed}`);
        lastKlineTimeRef.current = candle.time;

        updateCandle({
          time: candle.time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        });

        // 显示模式相关处理
        // - 正在形成的这根实时 K 两种模式下都保留显示 → 走快路径直接 update
        // - S/L 过滤模式:只有「可见 K 线集合」发生变化时才整段重建,
        //   否则只把现价参考线移到最新价。
        const wsState = useChartStore.getState();
        const mode: KlineDisplayMode = wsState.displayMode;
        const anchor = wsState.displayAnchorPrice;

        if (candleSeriesRef.current) {
          // 快路径:这根 K 本来就在序列里(实时 K 永远保留),直接更新
          // 注意:v4 的 update 会用新数据整根替换旧数据,不带 color 字段就会退回默认涨跌色,
          // 所以这里要把实时 K 的「独立 K 线」高亮色一起带上,否则会在橙色/默认色之间闪。
          const liveIdx = wsState.candles.length - 1;
          const standaloneColor = getStandaloneColor(wsState.candles, liveIdx, mode);
          const liveBar: CandlestickData<Time> = {
            time: candle.time as Time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          };
          if (standaloneColor) {
            liveBar.color = standaloneColor;
            liveBar.borderColor = standaloneColor;
            liveBar.wickColor = standaloneColor;
          }
          try {
            candleSeriesRef.current.update(liveBar);
          } catch {
            // v4 不允许更新比最后一条更早的数据 → 整段重建
            buildFilteredSeries();
          }

          if (mode !== "normal" && anchor !== null) {
            // 过滤模式:锚点现价已由 updateCandle 更新为实时 K 的最新收盘价
            const nextTimes = computeVisibleTimes(wsState.candles, mode, anchor);
            if (!isSameTimeList(nextTimes, appliedVisibleTimesRef.current)) {
              // 可见集合变了 → 重建序列
              buildFilteredSeries();
            } else {
              // 集合没变 → 只把「现价」参考线移到最新价
              syncAnchorPriceLine(mode, anchor);
            }
          }
        }

        // 更新成交量:实时 K 始终显示 → 成交量照常更新
        if (volumeSeriesRef.current) {
          const prevVolume = lastKlineTimeRef.current > 0
            ? useChartStore.getState().candles.find(c => c.time === lastKlineTimeRef.current)?.volume ?? 0
            : 0;
          const isHighVolume = prevVolume > 0 && (candle.volume ?? 0) >= prevVolume * 1.9;

          let color: string;
          if (isHighVolume) {
            color = candle.close >= candle.open ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)';
          } else {
            color = candle.close >= candle.open ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.4)';
          }

          volumeSeriesRef.current.update({
            time: candle.time as Time,
            value: candle.volume ?? 0,
            color,
          });
        }

        // K线收盘时重新计算指标
        if (isClosed) {
          const updatedCandles = useChartStore.getState().candles;
          calculateIndicators(updatedCandles);
        }
      });

      wsRef.current = ws;
      ws.connect();
      setConnected(true);
    };

    loadData().then(() => {
      if (!isCancelled) {
        startPolling();
      }
    });

    return () => {
      isCancelled = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.disconnect();
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [symbol, timeframe, setCandles, updateCandle, setLoading, setConnected, calculateIndicators, buildFilteredSeries, applyDisplayModePriceAxis, syncAnchorPriceLine]);

  // K 线显示模式变化(S / L 切换)→ 重新过滤 / 恢复全部 K 线
  // 注意:锚点现价会随实时行情每 tick 变化,不能放在依赖里 —— 否则每个 tick 都会整段重建。
  // 实时行情下的可见集合变化由 WebSocket 回调里按需重建(见上方 buildFilteredSeries 调用处)。
  useEffect(() => {
    buildFilteredSeries();
  }, [displayMode, buildFilteredSeries]);

  // 处理图表类型切换
  useEffect(() => {
    if (!candleSeriesRef.current || !highLineSeriesRef.current || !lowLineSeriesRef.current) return;

    if (chartType === "line") {
      candleSeriesRef.current.applyOptions({ visible: false });
      highLineSeriesRef.current.applyOptions({ visible: true });
      lowLineSeriesRef.current.applyOptions({ visible: true });
    } else {
      candleSeriesRef.current.applyOptions({ visible: true });
      highLineSeriesRef.current.applyOptions({ visible: false });
      lowLineSeriesRef.current.applyOptions({ visible: false });
    }
  }, [chartType]);

  // 合并加载所有周期的 OTE/FVG/OB/Trend 数据（优化：并行请求，避免重复）
  useEffect(() => {
    const allTimeframes = ['5m', '15m', '1h', '4h', '1d'] as const;
    let isCancelled = false;

    const loadAllMultiTimeframeData = async () => {
      const limit = (symbol === "BTCUSDC" || symbol === "ETHUSDC") ? 15000 : 3000;

      // 并行请求所有周期的 K 线数据（排除当前周期）
      const otherTimeframes = allTimeframes.filter(tf => tf !== timeframe);

      try {
        const results = await Promise.all(
          otherTimeframes.map(tf => fetchKlines(symbol, tf, limit).catch(() => []))
        );

        if (isCancelled) return;

        // 处理每个周期的数据
        otherTimeframes.forEach((tf, index) => {
          const data = results[index];
          if (data.length === 0) return;

          const lastPrice = data[data.length - 1].close;
          const swings = detectSwingPoints(data, getSwingLookback(tf));

          // OTE
          const otes = detectOTEZones(swings, lastPrice, data);
          setMultiTimeframeOTE(tf, otes[0] || null);

          // FVG(tier 基于当前周期的 swing points)
          const fvgs = detectFVGs(data, { swingPoints: swings });
          setMultiTimeframeFVG(tf, fvgs[fvgs.length - 1] || null);

          // OB
          const obs = detectOrderBlocks(data);
          const sortedObs = [...obs].sort((a, b) => b.startTime - a.startTime);
          setMultiTimeframeOB(tf, sortedObs[0] || null);

          // Trend
          // 新签名:detectStructure(candles, swingPoints) —— 传入该周期的 K 线数组
          const { bos, choch } = detectStructure(data, swings);
          let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
          if (choch.length > 0) {
            trend = choch[choch.length - 1].type;
          } else if (bos.length > 0) {
            trend = bos[bos.length - 1].type;
          }
          setMultiTimeframeTrend(tf, trend);

          // Equilibrium（HTF 面板用）
          const eqZones = detectEquilibriumZones(swings, lastPrice, data, 1);
          const top = eqZones[0];
          setMultiTimeframeEquilibrium(
            tf,
            top
              ? {
                  equilibrium: top.equilibrium,
                  side: top.side,
                  swingHigh: top.swingHigh,
                  swingLow: top.swingLow,
                }
              : null
          );
        });
      } catch (error) {
        console.error('Failed to load multi-timeframe data:', error);
      }
    };

    // 初始加载
    loadAllMultiTimeframeData();

    // 每 2 分钟刷新一次
    const interval = setInterval(loadAllMultiTimeframeData, 2 * 60 * 1000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [symbol, timeframe, setMultiTimeframeOTE, setMultiTimeframeFVG, setMultiTimeframeOB, setMultiTimeframeTrend, setMultiTimeframeEquilibrium]);

  // 加载K线计算前高前低 - 合并 4D+1D，取更保守的 P/D 值
  const { setDailyHL, dailyHL, dailyHLLines } = useChartStore();

  useEffect(() => {
    let isCancelled = false;

    // 通用的 H/L 计算函数
    const findAnchorAndCalculateHL = (
      klineData: Candle[],
      currentPrice: number
    ): { high: number; low: number; anchorTime: number } | null => {
      if (klineData.length < 2) return null;

      const latestCandle = klineData[klineData.length - 1];

      // 从倒数第二根K线向左扫描，找到包含当前价格的K线
      for (let i = klineData.length - 2; i >= 0; i--) {
        const candle = klineData[i];
        if (currentPrice >= candle.low && currentPrice <= candle.high) {
          return {
            high: Math.max(candle.high, latestCandle.high),
            low: Math.min(candle.low, latestCandle.low),
            anchorTime: candle.time,
          };
        }
      }
      return null;
    };

    // 计算 P/D 区域
    const calculatePD = (high: number, low: number) => {
      const range = high - low;
      const quarterRange = range / 4;
      return {
        pStart: high - quarterRange,
        dStart: low + quarterRange,
      };
    };

    const calculateDailyHL = async () => {
      try {
        // 获取1D数据
        const dailyData = await fetchKlines(symbol, '1d', 200);
        if (isCancelled || dailyData.length < 2) return;

        const currentPrice = dailyData[dailyData.length - 1].close;

        let hl4d: { high: number; low: number; anchorTime: number } | null = null;
        let hl1d: { high: number; low: number; anchorTime: number } | null = null;

        // 1. 尝试获取 4D K线
        try {
          const fourDayData = await fetchKlines(symbol, '4d', 200);
          if (!isCancelled && fourDayData.length >= 2) {
            hl4d = findAnchorAndCalculateHL(fourDayData, currentPrice);
          }
        } catch (e) {
          // 4D 不可用，继续
        }

        // 2. 获取 1D K线
        hl1d = findAnchorAndCalculateHL(dailyData, currentPrice);

        // 3. 合并结果
        if (!isCancelled) {
          if (hl4d && hl1d) {
            // 两者都有，合并取更保守的值
            const pd4d = calculatePD(hl4d.high, hl4d.low);
            const pd1d = calculatePD(hl1d.high, hl1d.low);

            const result = {
              high: Math.max(hl4d.high, hl1d.high),
              low: Math.min(hl4d.low, hl1d.low),
              pStart: Math.max(pd4d.pStart, pd1d.pStart),  // P 取大值，卖得更高
              dStart: Math.min(pd4d.dStart, pd1d.dStart),  // D 取小值，买得更低
              anchorTime: hl4d.anchorTime,
            };
            console.log(`[HLPD] 合并 4D+1D: P=${result.pStart.toFixed(0)} (4D:${pd4d.pStart.toFixed(0)}, 1D:${pd1d.pStart.toFixed(0)}), D=${result.dStart.toFixed(0)} (4D:${pd4d.dStart.toFixed(0)}, 1D:${pd1d.dStart.toFixed(0)})`);
            setDailyHL(result);
          } else if (hl4d) {
            const pd = calculatePD(hl4d.high, hl4d.low);
            console.log('[HLPD] 仅使用 4D K线');
            setDailyHL({ ...hl4d, ...pd });
          } else if (hl1d) {
            const pd = calculatePD(hl1d.high, hl1d.low);
            console.log('[HLPD] 仅使用 1D K线');
            setDailyHL({ ...hl1d, ...pd });
          } else {
            setDailyHL(null);
          }
        }
      } catch (error) {
        console.error('Failed to calculate daily H/L:', error);
        if (!isCancelled) {
          setDailyHL(null);
        }
      }
    };

    calculateDailyHL();

    // 每分钟刷新一次
    const interval = setInterval(calculateDailyHL, 60 * 1000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [symbol, setDailyHL]);

  // Initial Balance (21-22 北京) vs Europe Zone (15-20 北京) → Always In 检测
  useEffect(() => {
    let isCancelled = false;

    const calculateInitialBalance = async () => {
      try {
        // 1h 拿 IB 时段（13-14 UTC = 21-22 北京）
        // 15m 拿 Europe Zone（7-12 UTC = 15-20 北京）
        const [hourlyData, fifteenMinData] = await Promise.all([
          fetchKlines(symbol, '1h', 200).catch(() => []),
          fetchKlines(symbol, '15m', 200).catch(() => []),
        ]);
        if (isCancelled) return;
        const ib = computeInitialBalance(hourlyData, fifteenMinData);
        setInitialBalance(ib);
      } catch (error) {
        console.error('Failed to calculate Initial Balance:', error);
        if (!isCancelled) setInitialBalance(null);
      }
    };

    calculateInitialBalance();
    // 5 分钟刷新一次（IB 1 小时更新一次即可，5 分钟确保重算）
    const interval = setInterval(calculateInitialBalance, 5 * 60 * 1000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [symbol, setInitialBalance]);

  // Asia Open Window Bias (Premium/Discount 判定) — 用 2 根 15m K-line
  useEffect(() => {
    let isCancelled = false;

    const calculateBiases = async () => {
      try {
        // 15m K-line: 200 根 ≈ 50 小时，覆盖 prev today + buffer
        const candles15m = await fetchKlines(symbol, '15m', 200).catch(() => []);
        if (isCancelled) return;
        const asia = computeAsiaBias(candles15m);
        const europe = computeEuropeBias(candles15m);
        setAsiaBias(asia);
        setEuropeBias(europe);
      } catch (error) {
        console.error('Failed to calculate Asia/Europe Bias:', error);
        if (!isCancelled) {
          setAsiaBias(null);
          setEuropeBias(null);
        }
      }
    };

    calculateBiases();
    // 30 分钟刷新一次（8:15 / 16:00 北京前后是关键时间窗）
    const interval = setInterval(calculateBiases, 30 * 60 * 1000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [symbol, setAsiaBias, setEuropeBias]);

  // Update ICT Primitives with data
  useEffect(() => {
    // Update Order Blocks Primitive
    if (orderBlockPrimitiveRef.current) {
      if (enabled.orderBlocks) {
        orderBlockPrimitiveRef.current.setData(orderBlocks);
      } else {
        orderBlockPrimitiveRef.current.setData([]);
      }
    }

    // Update FVG Primitive
    if (fvgPrimitiveRef.current) {
      if (enabled.fvg) {
        fvgPrimitiveRef.current.setData(fvgs);
      } else {
        fvgPrimitiveRef.current.setData([]);
      }
    }

    // Update Fib Level Primitive(FVG/OB 的 3 档 fib 水平虚线)
    // FVG 档位跟随 FVG 开关,OB 档位跟随 Order Blocks 开关 —— 关掉哪个,对应虚线就消失
    if (fibLevelPrimitiveRef.current) {
      fibLevelPrimitiveRef.current.setData(
        buildFibLevels(fvgs, orderBlocks, enabled.fvg, enabled.orderBlocks),
        activeObFibRatio
      );
    }

    // Update Liquidity Primitive
    if (liquidityPrimitiveRef.current) {
      if (enabled.liquidityZones) {
        liquidityPrimitiveRef.current.setData(liquidityZones);
      } else {
        liquidityPrimitiveRef.current.setData([]);
      }
    }

    // Update Killzone Primitive（所有周期都画，由 store 开关控制）
    if (killzonePrimitiveRef.current) {
      killzonePrimitiveRef.current.setEnabled(enabled.killzones);
      killzonePrimitiveRef.current.setCandles(candles);
    }

    // Update OTE Primitive
    if (otePrimitiveRef.current) {
      if (enabled.ote) {
        otePrimitiveRef.current.setData(oteZones);
      } else {
        otePrimitiveRef.current.setData([]);
      }
    }

    // Update Rejection Primitive
    if (rejectionPrimitiveRef.current) {
      if (enabled.rejections) {
        const rejections = detectRejections(candles);
        rejectionPrimitiveRef.current.setData(rejections, candles);
      } else {
        rejectionPrimitiveRef.current.setData([]);
      }
    }

    // Update Breaker Block Primitive
    if (breakerBlockPrimitiveRef.current) {
      if (enabled.breakerBlocks) {
        breakerBlockPrimitiveRef.current.setData(breakerBlocks);
      } else {
        breakerBlockPrimitiveRef.current.setData([]);
      }
    }

    // Update Liquidation Hill Primitive
    if (liquidationHillPrimitiveRef.current) {
      liquidationHillPrimitiveRef.current.setData(liquidationData);
    }

    // Update Equilibrium Primitive
    if (equilibriumPrimitiveRef.current) {
      equilibriumPrimitiveRef.current.setData(
        enabled.equilibrium ? equilibriumLevels : []
      );
    }

    // Update ICT Setup Primitive（POI / 入场 / 止损 / 目标）
    if (ictSetupPrimitiveRef.current) {
      if (enabled.ictSetup) {
        ictSetupPrimitiveRef.current.setData(
          ictSetups.map((s) => ({
            direction: s.direction,
            state: s.state,
            pool: {
              level: s.pool.level,
              label: `${s.pool.isEqual ? "等" : "前"}${s.direction === "bullish" ? "低" : "高"}池`,
            },
            poi: s.poi
              ? { type: s.poi.type, high: s.poi.high, low: s.poi.low, startTime: s.poi.startTime }
              : undefined,
            entry: s.entry?.price,
            stopLoss: s.stopLoss,
            targets: s.targets,
          }))
        );
      } else {
        ictSetupPrimitiveRef.current.setData([]);
      }
    }
  }, [orderBlocks, fvgs, proximitySignals, liquidityZones, ictSetups, oteZones, breakerBlocks, equilibriumLevels, liquidationData, activeObFibRatio, enabled.orderBlocks, enabled.fvg, enabled.proximitySignals, enabled.liquidityZones, enabled.killzones, enabled.ote, enabled.breakerBlocks, enabled.equilibrium, enabled.ictSetup, timeframe]);

  // ===== 价格带(Price Band)=====
  // 加载月K —— 价格带的价位源头(月K 的 open/close + 阴K low + 阳K high)
  // 仅在开关打开时才拉月K(默认关闭),避免每次切 symbol 都多打一次后端请求
  useEffect(() => {
    let isCancelled = false;
    setMonthlyCandles([]);
    priceBandKeyRef.current = "";

    if (!enabled.priceBand) return;

    loadMonthlyCandles(symbol).then((monthly) => {
      if (!isCancelled) setMonthlyCandles(monthly);
    });

    return () => {
      isCancelled = true;
    };
  }, [symbol, enabled.priceBand]);

  // 计算价格带并绘制 —— 5 个阻力带(现价上方) + 5 个支撑带(现价下方),每档 ±200 点
  useEffect(() => {
    const primitive = priceBandPrimitiveRef.current;
    if (!primitive) return;

    if (!enabled.priceBand || monthlyCandles.length === 0) {
      primitive.setData([], []);
      priceBandKeyRef.current = "";
      return;
    }

    // 当前价格 = 实时 K 的最新收盘价
    const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : null;
    if (currentPrice === null || currentPrice <= 0) return;

    const band = computePriceBand(monthlyCandles, currentPrice);

    // 价位集合没变(实时 tick 只动了小数位)就不重绘
    const key = [...band.resistances, ...band.supports]
      .map((l) => l.price.toFixed(2))
      .join("|");
    if (key === priceBandKeyRef.current) return;
    priceBandKeyRef.current = key;

    primitive.setData(band.resistances, band.supports);
  }, [monthlyCandles, candles, enabled.priceBand]);

  // Update Swing Points Markers (蜡烛图模式)
  // ⚠️ setMarkers 是「覆盖式」的(同一 series 只能有一组 marker),
  //    所以回放成交标记必须和 swing 的 HH/LL 标记**合并**后一次性 setMarkers,
  //    并按 time 升序排序(lightweight-charts v4 要求)。
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    const markers: SeriesMarker<Time>[] = [];

    if (enabled.swingPoints && swingPoints.length > 0) {
      // 长 leg（相邻摆动点价差 > 1500 点）的两端特殊配色：HH 蓝、LL 橙
      const longLegIdx = findLongLegSwingIndices(swingPoints);
      for (const sp of swingPoints) {
        const isLongLeg = longLegIdx.has(sp.index);
        // 标签统一走 swingLabel:H/HL/LH/LL/H,L（同类中的第一个显示 H/L）
        const label = swingLabel(sp);
        markers.push({
          time: sp.time as Time,
          position: sp.type === "high" ? "aboveBar" : "belowBar",
          color: swingLabelColor(label, isLongLeg, sp.type),
          shape: sp.type === "high" ? "arrowDown" : "arrowUp",
          text: label,
        });
      }
    }

    // 回放成交标记
    if (replayFills.length > 0) {
      for (const f of replayFills) {
        const isEntry = f.kind === "entry";
        markers.push({
          time: f.time as Time,
          position: isEntry
            ? f.side === "buy" ? "belowBar" : "aboveBar"
            : f.side === "buy" ? "aboveBar" : "belowBar",
          color: isEntry ? (f.side === "buy" ? "#2563eb" : "#9333ea") : "#f59e0b",
          shape: isEntry ? (f.side === "buy" ? "arrowUp" : "arrowDown") : "circle",
          text: isEntry ? (f.side === "buy" ? "B" : "S") : f.reason === "sl" ? "SL" : f.reason === "tp" ? "TP" : "X",
        });
      }
    }

    if (markers.length === 0) {
      candleSeriesRef.current.setMarkers([]);
      return;
    }

    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candleSeriesRef.current.setMarkers(markers);
  }, [swingPoints, enabled.swingPoints, replayFills]);

  // 最近 5 个 HH / LL 向左延伸的虚射线(亮橙=HH,亮蓝=LL)
  // 数据源与图上 swing point 标记一致:最近的 5 个 swing high(记 HH)、5 个 swing low(记 LL)
  // age 越大(越旧)透明度越低,避免多条同色线糊成一片
  useEffect(() => {
    const primitive = swingRayPrimitiveRef.current;
    if (!primitive) return;

    if (!enabled.swingRays || swingPoints.length === 0) {
      primitive.setData([]);
      return;
    }

    const highs: SwingPoint[] = [];
    const lows: SwingPoint[] = [];
    for (const sp of swingPoints) {
      if (sp.type === "high") highs.push(sp);
      else lows.push(sp);
    }

    const rays: SwingRay[] = [];
    // 从最近往前取(倒序遍历,age 从 0 开始递增)
    for (let i = 0; i < Math.min(highs.length, SWING_RAY_COUNT); i++) {
      const sp = highs[highs.length - 1 - i];
      // 标签用真实的结构分类(HH/LH/H),不再写死
      rays.push({ label: swingLabel(sp), price: sp.price, time: sp.time, age: i });
    }
    for (let i = 0; i < Math.min(lows.length, SWING_RAY_COUNT); i++) {
      const sp = lows[lows.length - 1 - i];
      // 标签用真实的结构分类(HL/LL/L),不再写死
      rays.push({ label: swingLabel(sp), price: sp.price, time: sp.time, age: i });
    }
    primitive.setData(rays);
  }, [swingPoints, enabled.swingRays]);

  // 市场结构层:BOS / CHoCH 结构线 + 相邻摆动点连线
  //
  // 走 lightweight-charts 的 Primitive 管线（而不是 absolute 定位的 SVG 覆盖层）:
  // 价格轴是 autoScale 的,坐标必须每帧重算 —— SVG 覆盖层拿到的永远是过期坐标,
  // 线会飞到屏幕外(实测同一条线 y=-2976 而真实位置 y=396)。
  useEffect(() => {
    const primitive = structurePrimitiveRef.current;
    if (!primitive) return;

    const events: StructureEvent[] = [];
    if (enabled.bos) {
      for (const s of bosSignals) {
        events.push({
          kind: "bos",
          direction: s.type,
          level: s.level,
          breakTime: s.time,
          swingTime: s.swingPoint.time,
        });
      }
    }
    if (enabled.choch) {
      for (const s of chochSignals) {
        events.push({
          kind: "choch",
          direction: s.type,
          level: s.level,
          breakTime: s.time,
          swingTime: s.swingPoint.time,
        });
      }
    }
    primitive.setEvents(events);

    // 预测目标位（实线）—— 下一个 BOS / CHoCH 的目标价（门槛外侧的下一个结构位）
    const predictions: StructurePredictionEvent[] = [];
    if (structureProjection) {
      const push = (
        pred: StructureProjection["bullish"],
        fallbackKind: "bos" | "choch"
      ) => {
        if (!pred) return;
        if (pred.kind === "bos" && !enabled.bos) return;
        if (pred.kind === "choch" && !enabled.choch) return;
        predictions.push({
          kind: pred.kind ?? fallbackKind,
          direction: pred.direction,
          level: pred.level,
          swingTime: pred.swingPoint.time,
        });
      };
      push(structureProjection.bullish, "bos");
      push(structureProjection.bearish, "bos");
    }
    primitive.setPredictions(predictions);

    // Swing legs —— 相邻两个摆动点之间的连线
    const legs: SwingLeg[] = [];
    if (enabled.swingPoints && swingPoints.length > 1) {
      for (let i = 1; i < swingPoints.length; i++) {
        const prev = swingPoints[i - 1];
        const curr = swingPoints[i];
        legs.push({
          time1: prev.time,
          price1: prev.price,
          time2: curr.time,
          price2: curr.price,
          direction: curr.price > prev.price ? "up" : "down",
        });
      }
    }
    primitive.setLegs(legs);
  }, [bosSignals, chochSignals, structureProjection, swingPoints, enabled.bos, enabled.choch, enabled.swingPoints]);

  // Update Swing Points Markers (折线图模式) - 使用 detectAllPivots 标记所有波峰波谷
  useEffect(() => {
    if (chartType !== "line") return;
    if (!highLineSeriesRef.current || !lowLineSeriesRef.current) return;

    if (enabled.swingPoints) {
      // 使用 detectAllPivots 检测所有局部极值，再用 classifyPivots 分类为 HH/HL/LH/LL
      const candles = useChartStore.getState().candles;
      const allPivots = detectAllPivots(candles, 2, 2);
      const classifiedPivots = classifyPivots(allPivots, 0.5);

      if (classifiedPivots.length > 0) {
        // 长 leg（相邻摆动点价差 > 1500 点）的两端特殊配色：HH 蓝、LL 橙
        const longLegIdx = findLongLegSwingIndices(classifiedPivots);

        // 高线系列标记 HH/LH (局部高点)
        const highMarkers: SeriesMarker<Time>[] = classifiedPivots
          .filter((sp) => sp.type === "high")
          .map((sp) => {
            const label = swingLabel(sp);
            return {
              time: sp.time as Time,
              position: "inBar" as const,
              color: swingLabelColor(label, longLegIdx.has(sp.index), sp.type),
              shape: "circle" as const,
              text: label, // 显示 HH / LH / H
            };
          });

        // 低线系列标记 HL/LL (局部低点)
        const lowMarkers: SeriesMarker<Time>[] = classifiedPivots
          .filter((sp) => sp.type === "low")
          .map((sp) => {
            const label = swingLabel(sp);
            return {
              time: sp.time as Time,
              position: "inBar" as const,
              color: swingLabelColor(label, longLegIdx.has(sp.index), sp.type),
              shape: "circle" as const,
              text: label, // 显示 HL / LL / L
            };
          });

        highLineSeriesRef.current.setMarkers(highMarkers);
        lowLineSeriesRef.current.setMarkers(lowMarkers);
      } else {
        highLineSeriesRef.current.setMarkers([]);
        lowLineSeriesRef.current.setMarkers([]);
      }
    } else {
      highLineSeriesRef.current.setMarkers([]);
      lowLineSeriesRef.current.setMarkers([]);
    }
  }, [swingPoints, enabled.swingPoints, chartType]);

  // 日K锚点 OHLC 价格线（1D 实线 / 4D 虚线）
  //
  // 增量维护:价格变了用 applyOptions 原地移动,**不要** remove + recreate。
  // 原来每次 store 一变就把整批线删掉重建,加上 store 本身每个 tick 都变,
  // 结果就是线一闪就没,根本看不清。现在:
  //   - 缺哪条才 create
  //   - 价格变了才 applyOptions 移动
  //   - 不再需要的才 remove
  // 这批线由本 effect 独占(dk-PriceLinesRef),不放进 priceLinesRef,
  // 免得被下面「持仓/挂单」那个 effect 的整批清理误删。
  const dailyKPriceLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  useEffect(() => {
    const series = candleSeriesRef.current;
    const map = dailyKPriceLinesRef.current;

    if (!dailyKLineEnabled || !series) {
      // 开关关闭时清掉旧线
      map.forEach((line) => series?.removePriceLine(line));
      map.clear();
      return;
    }

    const LINE_COLORS: Record<'O' | 'H' | 'L' | 'C', string> = {
      O: '#3b82f6',  // 蓝
      H: '#ef4444',  // 红
      L: '#22c55e',  // 绿
      C: '#f97316',  // 橙
    };
    type DesiredLine = {
      tag: string;
      price: number;
      color: string;
      lineWidth: 1 | 2;
      lineStyle: 0 | 2;
      title: string;
    };
    const desired: DesiredLine[] = [];

    // 只画 1D（4D 聚合数据有时异常）
    const anchor = dailyKAnchors['1D'];
    if (anchor) {
      const FIELD: Record<'O' | 'H' | 'L' | 'C', 'open' | 'high' | 'low' | 'close'> = {
        O: 'open', H: 'high', L: 'low', C: 'close',
      };
      (['O', 'H', 'L', 'C'] as const).forEach((line) => {
        if (!anchor.visible[line]) return;
        desired.push({
          tag: `dk-1D-${line}`,
          price: anchor[FIELD[line]],
          color: LINE_COLORS[line],
          lineWidth: 1,
          lineStyle: 0,
          title: `1D ${line}`,
        });
      });

      // ===== 新增:日 K SR(R level + S level)+ 趋势 K 时画 OC 中点 =====
      // 跟 Rust 端 WickSR.level 公式一致
      const bodyTop = Math.max(anchor.open, anchor.close);
      const bodyBottom = Math.min(anchor.open, anchor.close);
      const body = Math.abs(anchor.close - anchor.open);
      const range = anchor.high - anchor.low;
      const bodyRatio = range > 0 ? body / range : 0;

      // 日 K SR:R level = (body_top + high) / 2, S level = (low + body_bottom) / 2
      // 总是画(跟 15m SR 概念一致,作为大级别参考)
      const srLines: Array<{ name: 'R' | 'S'; price: number; color: string }> = [
        { name: 'R', price: (bodyTop + anchor.high) / 2, color: '#ef4444' },  // 红
        { name: 'S', price: (anchor.low + bodyBottom) / 2, color: '#22c55e' }, // 绿
      ];
      srLines.forEach(({ name, price, color }) => {
        desired.push({
          tag: `dk-1D-sr-${name}`,
          price,
          color,
          lineWidth: 2,  // 粗一点突出大级别
          lineStyle: 2,  // 虚线区别于 O/H/L/C 实线
          title: `1D ${name}`,
        });
      });

      // 趋势 K 时(实体 ≥ 40% 整 K)画 OC 中点 = (open + close) / 2
      if (bodyRatio >= 0.4) {
        desired.push({
          tag: 'dk-1D-oc-mid',
          price: (anchor.open + anchor.close) / 2,
          color: '#8b5cf6',  // 紫
          lineWidth: 1,
          lineStyle: 0,  // 实线
          title: '1D OC Mid',
        });
      }
    }

    // 1. 删掉这次不需要的线(比如用户把某条线关掉了 / OC Mid 条件不再满足)
    const desiredTags = new Set(desired.map((d) => d.tag));
    map.forEach((line, tag) => {
      if (desiredTags.has(tag)) return;
      series.removePriceLine(line);
      map.delete(tag);
    });

    // 2. 新增 / 移动
    desired.forEach((d) => {
      const existing = map.get(d.tag);
      if (existing) {
        // 价格没变就什么都不做;变了就原地移动(不删了重建 → 不会闪)
        if (existing.options().price !== d.price) {
          existing.applyOptions({ price: d.price });
        }
        return;
      }
      const pl = series.createPriceLine({
        price: d.price,
        color: d.color,
        lineWidth: d.lineWidth,
        lineStyle: d.lineStyle,
        axisLabelVisible: true,
        title: d.title,
      });
      (pl as any)._tag = d.tag;
      map.set(d.tag, pl);
    });
  }, [dailyKAnchors, dailyKLineEnabled]);

  // ---------------------------------------------------------------------------
  // 回放模式价格线（持仓 entry/SL/TP + 挂单限价 + 表单草稿预览）
  // 增量维护:create / applyOptions 移动 / remove,和 dailyKPriceLinesRef 同一套路。
  // 这批线由本 effect 独占(replayPriceLinesRef),**不放进** priceLinesRef,
  // 免得被上面「持仓/挂单」那个 effect 的整批清理误删。
  // ---------------------------------------------------------------------------
  const replayPriceLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  useEffect(() => {
    const series = candleSeriesRef.current;
    const map = replayPriceLinesRef.current;

    type DesiredLine = {
      tag: string;
      price: number;
      color: string;
      lineWidth: 1 | 2;
      lineStyle: 0 | 2;
      title: string;
    };
    const desired: DesiredLine[] = [];

    // 持仓:entry(实线) / SL(红虚线) / TP(绿虚线)
    for (const p of replayPositions) {
      const entryColor = p.side === "buy" ? "#2563eb" : "#9333ea";
      desired.push({
        tag: `rp-entry-${p.id}`,
        price: p.entryPrice,
        color: entryColor,
        lineWidth: 2,
        lineStyle: 0,
        title: `${p.side === "buy" ? "多" : "空"}仓`,
      });
      if (p.stopLoss != null) {
        desired.push({
          tag: `rp-sl-${p.id}`,
          price: p.stopLoss,
          color: "#ef4444",
          lineWidth: 1,
          lineStyle: 2,
          title: "SL",
        });
      }
      if (p.takeProfit != null) {
        desired.push({
          tag: `rp-tp-${p.id}`,
          price: p.takeProfit,
          color: "#22c55e",
          lineWidth: 1,
          lineStyle: 2,
          title: "TP",
        });
      }
    }

    // 挂单:限价线
    for (const o of replayOrders) {
      if (o.status !== "pending") continue;
      desired.push({
        tag: `ro-${o.id}`,
        price: o.price,
        color: "#f97316",
        lineWidth: 1,
        lineStyle: 2,
        title: o.side === "buy" ? "挂买" : "挂卖",
      });
    }

    // 表单草稿预览(entry / SL / TP)
    if (replayDraft) {
      const d = replayDraft;
      if (d.entry != null && d.entry > 0) {
        desired.push({
          tag: "rp-draft-entry",
          price: d.entry,
          color: d.side === "buy" ? "#2563eb" : "#9333ea",
          lineWidth: 1,
          lineStyle: 2,
          title: "模拟入场",
        });
      }
      if (d.stopLoss != null && d.stopLoss > 0) {
        desired.push({
          tag: "rp-draft-sl",
          price: d.stopLoss,
          color: "#ef4444",
          lineWidth: 1,
          lineStyle: 2,
          title: "模拟 SL",
        });
      }
      if (d.takeProfit != null && d.takeProfit > 0) {
        desired.push({
          tag: "rp-draft-tp",
          price: d.takeProfit,
          color: "#22c55e",
          lineWidth: 1,
          lineStyle: 2,
          title: "模拟 TP",
        });
      }
    }

    if (!series) {
      map.clear();
      return;
    }

    // 1. 删掉这次不需要的线
    const desiredTags = new Set(desired.map((d) => d.tag));
    map.forEach((line, tag) => {
      if (desiredTags.has(tag)) return;
      series.removePriceLine(line);
      map.delete(tag);
    });

    // 2. 新增 / 移动
    desired.forEach((d) => {
      const existing = map.get(d.tag);
      if (existing) {
        if (existing.options().price !== d.price) {
          existing.applyOptions({ price: d.price });
        }
        return;
      }
      const pl = series.createPriceLine({
        price: d.price,
        color: d.color,
        lineWidth: d.lineWidth,
        lineStyle: d.lineStyle,
        axisLabelVisible: true,
        title: d.title,
      });
      (pl as unknown as { _tag?: string })._tag = d.tag;
      map.set(d.tag, pl);
    });
  }, [replayPositions, replayOrders, replayDraft]);

  // 换 symbol → 旧 symbol 的日K锚点线先撤掉(等新锚点到了再画)
  useEffect(() => {
    const map = dailyKPriceLinesRef.current;
    map.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    map.clear();
  }, [symbol]);
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // 清除旧的价格线
    priceLinesRef.current.forEach((line) => {
      candleSeriesRef.current?.removePriceLine(line);
    });
    priceLinesRef.current = [];

    const currentSymbol = symbol.replace('/', '');

    // 1. 显示持仓入场价格（实线）
    const currentPositions = positions.filter(p => p.symbol === currentSymbol);
    currentPositions.forEach((pos) => {
      if (!candleSeriesRef.current) return;
      const priceLine = candleSeriesRef.current.createPriceLine({
        price: pos.entryPrice,
        color: pos.side === 'long' ? '#3b82f6' : '#a855f7',
        lineWidth: 2,
        lineStyle: 0, // 实线
        axisLabelVisible: true,
        title: `持仓 ${pos.quantity}`,
      });
      priceLinesRef.current.push(priceLine);
    });

    // 2. 显示限价挂单（虚线）
    realOrders
      .filter(o => o.symbol === currentSymbol && o.type.toLowerCase() === 'limit')
      .forEach((order) => {
        if (!candleSeriesRef.current || !order.price) return;

        // 判断是开仓还是平仓（止盈）
        // BUY + LONG = 开多, SELL + SHORT = 开空 → 开仓限价
        // SELL + LONG = 平多, BUY + SHORT = 平空 → 平仓限价（止盈）
        const isLong = order.positionSide === 'LONG';
        const isBuy = order.side.toUpperCase() === 'BUY';
        const isOpen = (isBuy && isLong) || (!isBuy && !isLong);

        // 也可以通过 clientOrderId 判断是否为止盈单
        const isTpOrder = order.clientOrderId?.includes('_tp');

        const priceLine = candleSeriesRef.current.createPriceLine({
          price: order.price,
          color: isOpen
            ? (isLong ? '#3b82f6' : '#a855f7')  // 开仓：蓝/紫
            : '#22c55e',  // 平仓（止盈）：绿
          lineWidth: 1,
          lineStyle: 2, // 虚线
          axisLabelVisible: true,
          title: (isOpen && !isTpOrder) ? `限价 ${order.quantity}` : `TP ${order.quantity}`,
        });
        priceLinesRef.current.push(priceLine);
      });

    // 3. 显示止盈止损挂单（仅当有持仓时）
    if (currentPositions.length > 0) {
      realOrders
        .filter(o => o.symbol === currentSymbol)
        .forEach((order) => {
          if (!candleSeriesRef.current) return;
          const price = order.stopPrice || order.price;
          if (!price) return;

          if (order.type.toLowerCase().includes('profit')) {
            const priceLine = candleSeriesRef.current.createPriceLine({
              price,
              color: '#22c55e', // 绿色
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: 'TP',
            });
            priceLinesRef.current.push(priceLine);
          } else if (order.type.toLowerCase().includes('stop') && !order.type.toLowerCase().includes('profit')) {
            const priceLine = candleSeriesRef.current.createPriceLine({
              price,
              color: '#ef4444', // 红色
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: 'SL',
            });
            priceLinesRef.current.push(priceLine);
          }
        });
    }

    // 4. 显示手动输入的交易线（原有逻辑）
    if (tradingLines.length > 0) {
      tradingLines.forEach((line) => {
        if (!candleSeriesRef.current) return;

        let color: string;
        let title: string;
        if (line.type === "entry") {
          color = line.side === "buy" ? "#3b82f6" : "#a855f7";
          title = "Entry";
        } else if (line.type === "stopLoss") {
          color = "#ef4444";
          title = "SL";
        } else {
          color = "#22c55e";
          title = "TP";
        }

        const priceLine = candleSeriesRef.current.createPriceLine({
          price: line.price,
          color,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title,
        });

        priceLinesRef.current.push(priceLine);
      });
    }

    // 5. 显示日K前高前低价格线 (根据选中状态，使用已合并的 P/D 值)
    if (dailyHL) {
      // H - 前高 (浅红)
      if (dailyHLLines.H) {
        const highLine = candleSeriesRef.current.createPriceLine({
          price: dailyHL.high,
          color: '#f87171',  // red-400
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'H',
        });
        priceLinesRef.current.push(highLine);
      }

      // P - 溢价区开始（使用合并后的值）
      if (dailyHLLines.P) {
        const pLine = candleSeriesRef.current.createPriceLine({
          price: dailyHL.pStart,
          color: '#ef4444',  // 红色
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'P',
        });
        priceLinesRef.current.push(pLine);
      }

      // D - 折扣区开始（使用合并后的值）
      if (dailyHLLines.D) {
        const dLine = candleSeriesRef.current.createPriceLine({
          price: dailyHL.dStart,
          color: '#22c55e',  // 绿色
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'D',
        });
        priceLinesRef.current.push(dLine);
      }

      // L - 前低 (浅绿)
      if (dailyHLLines.L) {
        const lowLine = candleSeriesRef.current.createPriceLine({
          price: dailyHL.low,
          color: '#4ade80',  // green-400
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'L',
        });
        priceLinesRef.current.push(lowLine);
      }
    }
  }, [tradingLines, realOrders, positions, symbol, dailyHL, dailyHLLines]);

  // 测量模式或 Shift 按下时禁用图表拖动
  const shouldDisableChartInteraction = phase === "drawing" || (canStartMeasure && phase === "idle");

  useEffect(() => {
    if (!chartRef.current) return;

    chartRef.current.applyOptions({
      handleScroll: !shouldDisableChartInteraction,
      handleScale: !shouldDisableChartInteraction,
    });
  }, [shouldDisableChartInteraction]);

  // 双击图表下单的拖动逻辑:pointermove 时改 store + prefillData
  //   用 PointerEvent 统一鼠标和触摸(iPad/手机)
  useEffect(() => {
    if (!dragState.active) return;

    const handleMove = (e: PointerEvent) => {
      if (!candleSeriesRef.current) return;
      // 用 chartContainerRef 当前屏幕位置 + dy 算新价
      const rect = chartContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const yNow = candleSeriesRef.current.priceToCoordinate(dragState.startPrice);
      if (yNow == null) return;
      const newY = yNow + (e.clientY - dragState.startY);
      const newPrice = candleSeriesRef.current.coordinateToPrice(newY);
      if (newPrice == null || newPrice <= 0) return;

      // 更新 store 中的 tradingLines(实时跟随)
      const current = useOrderStore.getState().tradingLines;
      if (dragState.lineIdx >= current.length) return;
      const updated = [...current];
      updated[dragState.lineIdx] = { ...updated[dragState.lineIdx], price: newPrice };
      useOrderStore.setState({ tradingLines: updated });

      // 同步 Modal 里的 entry 输入框
      const cur = useOrderStore.getState().prefillData;
      if (cur) {
        useOrderStore.setState({
          prefillData: { ...cur, entry: newPrice },
        });
      }
    };

    const handleUp = () => {
      setDragState((s) => ({ ...s, active: false }));
    };

    // pointer 事件统一处理鼠标/触摸/笔;iPad 用 setPointerCapture 后
    // 这里仍要监听 window,确保离开 chart container 也能继续追踪
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [dragState]);

  // 获取坐标点信息 - 始终返回屏幕坐标，支持时间外推
  const getPointFromEvent = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!chartRef.current || !candleSeriesRef.current) return null;

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // 尝试转换价格（价格轴通常可以无限延伸）
      const priceCoord = candleSeriesRef.current.coordinateToPrice(y);
      const price = priceCoord !== null ? priceCoord : null;

      // 尝试转换时间
      const timeCoord = chartRef.current.timeScale().coordinateToTime(x);
      let time: number | null = null;

      if (timeCoord !== null && typeof timeCoord === "number") {
        time = timeCoord;
      } else if (candles.length >= 2) {
        // 外推时间：基于K线的时间间隔
        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles[candles.length - 2];
        const candleInterval = lastCandle.time - prevCandle.time; // 时间间隔（秒）

        // 获取最后一根K线的 x 坐标
        const lastCandleX = chartRef.current.timeScale().timeToCoordinate(lastCandle.time as Time);

        if (lastCandleX !== null) {
          // 计算像素到K线数量的比例
          const visibleRange = chartRef.current.timeScale().getVisibleLogicalRange();
          if (visibleRange) {
            const barsCount = visibleRange.to - visibleRange.from;
            const pixelsPerBar = rect.width / barsCount;

            // 外推时间（向右或向左都支持）
            const extraBars = (x - lastCandleX) / pixelsPerBar;
            time = lastCandle.time + Math.round(extraBars) * candleInterval;
          }
        }
      }

      // 始终返回屏幕坐标，价格/时间尽可能计算
      return {
        price,
        time,
        x,
        y,
      };
    },
    [candles]
  );

  // 点击处理：TradingView 风格的点击-移动-点击模式
  // 第一次点击开始测量，第二次点击直接清除（测量数据在移动时实时显示）
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // iPad/触摸路径:触摸产生的 click 是触摸事件触发的延迟 click,
      // 触摸路径已自己处理(touchend 检双击/单击),
      // 这里不再响应,避免触摸路径与鼠标路径冲突
      if (lastTapRef.current.time > 0) return;

      const point = getPointFromEvent(e);
      if (!point) return;

      // idle 状态 + 可以开始测量 -> 开始绘制
      if (phase === "idle" && canStartMeasure) {
        startDrawing(point, timeframe);
        return;
      }

      // drawing 状态 -> 直接清除（测量结果已在移动时显示）
      if (phase === "drawing") {
        clearMeasurement();
        return;
      }

      // completed 状态（保留以防万一）-> 清除
      if (phase === "completed") {
        clearMeasurement();
        return;
      }
    },
    [phase, canStartMeasure, getPointFromEvent, startDrawing, clearMeasurement, timeframe]
  );

  // 双击图表下单的核心逻辑(从坐标下单,不绑定具体事件类型)
  //   - 双击位置价格 > 当前收盘价 → SELL/SHORT(开空)
  //   - 双击位置价格 < 当前收盘价 → BUY/LONG(开多)
  //   - 弹 TradeModal,entry 预填双击位置,SL/TP 留空
  const placeOrderAtPoint = useCallback(
    (point: { price: number | null; time: number | null; x: number; y: number } | null | undefined) => {
      if (!point || point.price == null) return;

      const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : point.price;
      // 严格大于当前价 → 开空,小于等于 → 开多
      const side: "buy" | "sell" = point.price > currentPrice ? "sell" : "buy";

      // 设置 entry 价格线(覆盖之前的 chart 来源线,保留面板来源的)
      const current = useOrderStore.getState().tradingLines;
      const chartLines = current.filter((l) => l.source !== "chart");
      const newLine: TradingLine = {
        price: point.price,
        type: "entry",
        side,
        source: "chart",
        draggable: true,
      };
      useOrderStore.setState({ tradingLines: [...chartLines, newLine] });

      // 弹 modal,预填 side + entry,SL/TP 让用户填
      setPrefillData({ side, entry: point.price, stopLoss: 0, takeProfit: 0 });
      openModal();
    },
    [candles, setPrefillData, openModal]
  );

  // 鼠标双击下单:桌面路径
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      placeOrderAtPoint(getPointFromEvent(e));
    },
    [getPointFromEvent, placeOrderAtPoint]
  );

  // iPad/触摸双击检测:不依赖浏览器 dblclick 事件(iOS Safari 上不可靠)
  //   - 两次 tap 在 350ms 内、距离 < 20px 视为双击
  //   - 第二次 tap 触发 placeOrderAtPoint
  // lastTapRef 已在组件顶部声明(与其他 useRef 一起)

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      // 多指操作或无 changedTouches 时忽略
      if (e.touches.length > 0 || e.changedTouches.length === 0) return;
      const touch = e.changedTouches[0];

      const now = Date.now();
      const last = lastTapRef.current;
      const dx = touch.clientX - last.x;
      const dy = touch.clientY - last.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // 第二次 tap 在时间/距离窗口内 → 视为双击
      if (now - last.time < 350 && dist < 20) {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        const price = candleSeriesRef.current?.coordinateToPrice(y);
        if (price != null && price > 0) {
          placeOrderAtPoint({ price, time: null, x, y });
        }
        // 重置 + 阻止后续 click 触发测距(测距由鼠标路径处理)
        lastTapRef.current = { time: 0, x: 0, y: 0 };
        e.preventDefault();
        return;
      }

      // 第一次 tap,记录
      lastTapRef.current = { time: now, x: touch.clientX, y: touch.clientY };
    },
    [placeOrderAtPoint]
  );

  // mousemove: 更新测量（仅在 drawing 状态）
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (phase !== "drawing") return;

      const point = getPointFromEvent(e);
      if (point) {
        updateDrawing(point, timeframe);
      }
    },
    [phase, getPointFromEvent, updateDrawing, timeframe]
  );

  // 根据状态决定光标样式
  const getCursor = () => {
    if (phase === "drawing") return "crosshair";
    if (canStartMeasure) return "crosshair";
    if (phase === "completed") return "pointer";
    return "default";
  };

  return (
    <div className="w-full h-full relative">
      {ohlcvData && (
        <div className="absolute top-0 left-0 right-0 z-20 bg-[#ffffff]/95 backdrop-blur-sm border-b border-gray-200 px-3 py-1.5 flex items-center gap-3 text-xs font-mono pointer-events-none">
          <span className="text-gray-400">
            {new Date(ohlcvData.time * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className={ohlcvData.close >= ohlcvData.open ? 'text-green-600' : 'text-red-600'}>
            O <span className="font-semibold">{ohlcvData.open.toFixed(2)}</span>
          </span>
          <span className="text-gray-600">
            H <span className="font-semibold">{ohlcvData.high.toFixed(2)}</span>
          </span>
          <span className="text-gray-600">
            L <span className="font-semibold">{ohlcvData.low.toFixed(2)}</span>
          </span>
          <span className={ohlcvData.close >= ohlcvData.open ? 'text-green-600' : 'text-red-600'}>
            C <span className="font-semibold">{ohlcvData.close.toFixed(2)}</span>
          </span>
          <span className="text-blue-600">
            V <span className="font-semibold">
              {ohlcvData.volume >= 1e6
                ? (ohlcvData.volume / 1e6).toFixed(2) + 'M'
                : ohlcvData.volume >= 1e3
                  ? (ohlcvData.volume / 1e3).toFixed(2) + 'K'
                  : ohlcvData.volume.toFixed(2)}
            </span>
          </span>
          <span className="text-purple-600">
            CHG <span className="font-semibold">{Math.abs(ohlcvData.close - ohlcvData.open).toFixed(2)}</span>
          </span>
        </div>
      )}
      <div
        ref={chartContainerRef}
        className="w-full h-full relative"
        // touch-action: manipulation 禁用 iOS Safari 300ms 双击延迟,
        // 同时保留 lightweight-charts 的 pan/pinch zoom
        style={{ minHeight: "400px", cursor: getCursor(), touchAction: "manipulation" }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseMove={handleMouseMove}
        // iPad/触摸路径:手动双击检测,不依赖浏览器 dblclick
        onTouchEnd={handleTouchEnd}
      />
      {/* 双击下单的可拖动 entry 线手柄(绝对定位在 chart container 内) */}
      <DragHandles
        containerRef={chartContainerRef}
        seriesRef={candleSeriesRef}
        tradingLines={tradingLines}
        onDragStart={(lineIdx, startY, startPrice) =>
          setDragState({ active: true, lineIdx, startY, startPrice })
        }
      />
      <ICTOverlay
        chartRef={chartRef}
        seriesRef={candleSeriesRef}
        containerRef={chartContainerRef}
      />
      <OrderCancelOverlay
        chartRef={chartRef}
        seriesRef={candleSeriesRef}
        containerRef={chartContainerRef}
      />
      <div ref={rightPanelsRef} data-testid="chart-right-panels" className="absolute top-2 right-2 z-10 flex flex-col gap-2">
        {/* 回放模拟盘面板(置顶) */}
        <ReplayPanel />
        {/* ICT Setup 状态机(流动性 → 扫荡 → 位移 → 回踩 POI → 可入场) */}
        <ICTSetupPanel />
        {/* 最长波段(独立面板,折叠互不影响)—— 仅 admin 可见 */}
        {user?.role === 'admin' && <LongestSwingPanel />}
        <OTEPanel />
        <FVGPanel />
        <OBPanel />
        <DailyKPanel />
        {user?.role === 'admin' && <LiquidityGridPanel />}
      </div>
      <MeasurementTool />
      {/* 回放控制条(图表底部) */}
      <ReplayControlBar />
    </div>
  );
}

/**
 * 双击下单产生的 entry 价格线的可拖动手柄
 * - 12px 高横向 hit area,覆盖整条价格线宽度
 * - 鼠标悬停 cursor 变 ns-resize
 * - onMouseDown 启动拖动(mousemove 在 TradingChart 内全局监听)
 */
function DragHandles({
  containerRef,
  seriesRef,
  tradingLines,
  onDragStart,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  seriesRef: any;
  tradingLines: TradingLine[];
  onDragStart: (lineIdx: number, startY: number, startPrice: number) => void;
}) {
  if (!tradingLines || tradingLines.length === 0) return null;

  return (
    <>
        {tradingLines.map((line, idx) => {
          if (!line.draggable) return null;
          const y = seriesRef.current?.priceToCoordinate?.(line.price);
          if (y == null) return null;
          return (
            <div
              key={`drag-handle-${idx}`}
              // onPointerDown 统一鼠标/触摸;iPad 用 setPointerCapture
              // 锁住 pointer,确保拖动期间即使手离开元素仍能收到 pointermove
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const target = e.currentTarget as HTMLElement;
                try {
                  target.setPointerCapture(e.pointerId);
                } catch {
                  // setPointerCapture 在某些环境下可能抛错,忽略
                }
                onDragStart(idx, e.clientY, line.price);
              }}
              style={{
                position: "absolute",
                top: y - 6,
                left: 0,
                right: 0,
                height: 12,
                cursor: "ns-resize",
                zIndex: 5,
                // 触摸设备上 12px 太小,放大到 24px 方便手指点击
                minHeight: 24,
                touchAction: "none",
              }}
            />
          );
        })}
      </>
  );
}
