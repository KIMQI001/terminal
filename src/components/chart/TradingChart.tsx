"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  LineData,
  Time,
  SeriesMarker,
  IPriceLine,
} from "lightweight-charts";
import { useChartStore } from "@/stores/chartStore";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useMeasurementStore } from "@/stores/measurementStore";
import { useOrderStore } from "@/stores/orderStore";
import { usePositionStore } from "@/stores/positionStore";
import { useUserStore } from "@/stores/userStore";
import { MeasurementTool } from "./MeasurementTool";
import { ICTOverlay } from "./ICTOverlay";
import { OTEPanel } from "./OTEPanel";
import { FVGPanel } from "./FVGPanel";
import { LiquidationPanel } from "./LiquidationPanel";
import { LiquidationCGPanel } from "./LiquidationCGPanel";
import { LiquidityGridPanel } from "./LiquidityGridPanel";
import { OBPanel } from "./OBPanel";
import { OrderCancelOverlay } from "./OrderCancelOverlay";
import { fetchKlines } from "@/lib/binance/api";
import { BinanceWebSocket } from "@/lib/binance/websocket";
import { detectSwingPoints, detectPivotsFull, detectAllPivots, classifyPivots } from "@/lib/chart/indicators/swingPoints";
import { detectOrderBlocks } from "@/lib/chart/indicators/orderBlocks";
import { detectEngulfingPinbar } from "@/lib/chart/indicators/engulfingPinbar";
import { detectFVGs } from "@/lib/chart/indicators/fvg";
import { detectStructure } from "@/lib/chart/indicators/structure";
import { detectLiquidityZones } from "@/lib/chart/indicators/liquidity";
import { Candle } from "@/types/chart";
import {
  OrderBlockPrimitive,
  FVGPrimitive,
  LiquidityPrimitive,
  KillzonePrimitive,
  OTEPrimitive,
  BreakerBlockPrimitive,
  LiquidationHillPrimitive,
} from "@/lib/chart/primitives";
import { detectOTEZones } from "@/lib/chart/indicators/ote";
import { detectBreakerBlocks } from "@/lib/chart/indicators/breakerBlocks";
import { detectInducements } from "@/lib/chart/indicators/inducement";

export function TradingChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const highLineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lowLineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const wsRef = useRef<BinanceWebSocket | null>(null);

  // ICT Primitives
  const orderBlockPrimitiveRef = useRef<OrderBlockPrimitive | null>(null);
  const fvgPrimitiveRef = useRef<FVGPrimitive | null>(null);
  const liquidityPrimitiveRef = useRef<LiquidityPrimitive | null>(null);
  const killzonePrimitiveRef = useRef<KillzonePrimitive | null>(null);
  const otePrimitiveRef = useRef<OTEPrimitive | null>(null);
  const breakerBlockPrimitiveRef = useRef<BreakerBlockPrimitive | null>(null);
  const liquidationHillPrimitiveRef = useRef<LiquidationHillPrimitive | null>(null);

  // Trading price lines
  const priceLinesRef = useRef<IPriceLine[]>([]);

  // Shift 键状态
  const [isShiftPressed, setIsShiftPressed] = useState(false);

  const {
    symbol,
    timeframe,
    chartType,
    candles,
    liquidationData,
    setCandles,
    setChartType,
    updateCandle,
    setLoading,
    setConnected,
  } = useChartStore();

  const {
    enabled,
    swingPoints,
    missedPivots,
    ghostLevels,
    orderBlocks,
    fvgs,
    liquidityZones,
    oteZones,
    breakerBlocks,
    setSwingPoints,
    setMissedPivots,
    setGhostLevels,
    setOrderBlocks,
    setFVGs,
    setBOSSignals,
    setCHoCHSignals,
    setLiquidityZones,
    setOTEZones,
    setBreakerBlocks,
    setInducements,
    setMultiTimeframeOTE,
    setMultiTimeframeFVG,
    setMultiTimeframeOB,
    setMultiTimeframeTrend,
  } = useIndicatorStore();

  const {
    phase,
    isToolActive,
    startDrawing,
    updateDrawing,
    clearMeasurement,
  } = useMeasurementStore();

  const { tradingLines, realOrders, fetchOpenOrders } = useOrderStore();
  const { positions, fetchPositions } = usePositionStore();
  const { user } = useUserStore();

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

  // 图表加载时自动获取订单和持仓，并定时刷新
  useEffect(() => {
    fetchOpenOrders(symbol);
    fetchPositions();

    const interval = setInterval(() => {
      fetchOpenOrders(symbol);
      fetchPositions();
    }, 5000);

    return () => clearInterval(interval);
  }, [symbol, fetchOpenOrders, fetchPositions]);

  // 可以开始测量的条件：Shift 按下 或 工具栏激活
  const canStartMeasure = isShiftPressed || isToolActive;

  // Calculate indicators when candles change
  const calculateIndicators = useCallback(
    (candleData: Candle[]) => {
      if (candleData.length < 10) return;

      // Swing points (LuxAlgo 风格 length=50，包含 missed pivots 和 ghost levels)
      const pivotResult = detectPivotsFull(candleData, 50);
      setSwingPoints(pivotResult.pivots);
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

      // FVG 始终计算（面板需要数据）
      const fvgs = detectFVGs(candleData);
      setFVGs(fvgs);
      // 保存到多周期 FVG 存储（只保存最新的一个）
      const targetTimeframes2 = ['5m', '15m', '1h', '4h', '1d'] as const;
      if (targetTimeframes2.includes(timeframe as typeof targetTimeframes2[number])) {
        setMultiTimeframeFVG(timeframe, fvgs[fvgs.length - 1] || null);
      }

      // BOS/CHoCH 始终计算（MTF Trend 面板需要数据）
      const lastPriceForStructure = candleData[candleData.length - 1].close;
      const { bos, choch } = detectStructure(pivotResult.pivots, lastPriceForStructure);
      if (enabled.bos) setBOSSignals(bos);
      if (enabled.choch) setCHoCHSignals(choch);

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

      // OTE zones 始终计算（面板需要数据）
      const lastPrice = candleData[candleData.length - 1].close;
      const otes = detectOTEZones(pivotResult.pivots, lastPrice, candleData);
      setOTEZones(otes);
      // 保存到多周期 OTE 存储（只保存最新的一个）
      const targetTimeframes3 = ['5m', '15m', '1h', '4h', '1d'] as const;
      if (targetTimeframes3.includes(timeframe as typeof targetTimeframes3[number])) {
        setMultiTimeframeOTE(timeframe, otes[0] || null);
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
    },
    [enabled, timeframe, setSwingPoints, setMissedPivots, setGhostLevels, setOrderBlocks, setFVGs, setBOSSignals, setCHoCHSignals, setLiquidityZones, setOTEZones, setBreakerBlocks, setInducements, setMultiTimeframeOTE, setMultiTimeframeFVG, setMultiTimeframeOB, setMultiTimeframeTrend]
  );

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
    const fvgPrimitive = new FVGPrimitive();
    const liquidityPrimitive = new LiquidityPrimitive();
    const killzonePrimitive = new KillzonePrimitive();
    const otePrimitive = new OTEPrimitive();
    const breakerBlockPrimitive = new BreakerBlockPrimitive();
    const liquidationHillPrimitive = new LiquidationHillPrimitive();

    // Attach primitives in order (bottom layer first)
    candleSeries.attachPrimitive(killzonePrimitive);
    candleSeries.attachPrimitive(otePrimitive);
    candleSeries.attachPrimitive(breakerBlockPrimitive);
    candleSeries.attachPrimitive(obPrimitive);
    candleSeries.attachPrimitive(fvgPrimitive);
    candleSeries.attachPrimitive(liquidityPrimitive);
    candleSeries.attachPrimitive(liquidationHillPrimitive);

    orderBlockPrimitiveRef.current = obPrimitive;
    fvgPrimitiveRef.current = fvgPrimitive;
    liquidityPrimitiveRef.current = liquidityPrimitive;
    killzonePrimitiveRef.current = killzonePrimitive;
    otePrimitiveRef.current = otePrimitive;
    breakerBlockPrimitiveRef.current = breakerBlockPrimitive;
    liquidationHillPrimitiveRef.current = liquidationHillPrimitive;

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, []);

  // Fetch data and setup WebSocket
  useEffect(() => {
    // 使用标记来处理竞态条件
    let isCancelled = false;
    const currentSymbol = symbol;
    const currentTimeframe = timeframe;

    // 立即断开旧的 WebSocket，防止旧数据继续推送
    if (wsRef.current) {
      wsRef.current.disconnect();
      wsRef.current = null;
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
        // BTC/ETH 请求 5000 根，其他交易对请求 1000 根
        const limit = (currentSymbol === "BTCUSDC" || currentSymbol === "ETHUSDC") ? 5000 : 1000;
        const data = await fetchKlines(currentSymbol, currentTimeframe, limit);

        // 检查是否已被取消（symbol/timeframe 已变化）
        if (isCancelled) {
          return;
        }

        setCandles(data);
        calculateIndicators(data);

        if (candleSeriesRef.current && chartRef.current) {
          // 先计算 Swing Points
          const pivotResult = detectPivotsFull(data, 50);
          const pinbars = detectEngulfingPinbar(data, pivotResult.pivots, 5);
          const pinbarTimes = new Set(pinbars.map(p => p.time));

          // 构建带颜色的蜡烛数据
          const chartData: CandlestickData<Time>[] = data.map((c) => {
            const isPinbar = pinbarTimes.has(c.time);
            const pinbar = pinbars.find(p => p.time === c.time);

            if (isPinbar && pinbar) {
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

            return {
              time: c.time as Time,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
            };
          });
          candleSeriesRef.current.setData(chartData);

          // 设置折线图数据
          if (highLineSeriesRef.current && lowLineSeriesRef.current) {
            const highData: LineData<Time>[] = data.map(c => ({ time: c.time as Time, value: c.high }));
            const lowData: LineData<Time>[] = data.map(c => ({ time: c.time as Time, value: c.low }));
            highLineSeriesRef.current.setData(highData);
            lowLineSeriesRef.current.setData(lowData);
          }

          // 切换 symbol 后让图表自适应价格轴范围
          chartRef.current.timeScale().fitContent();
        }

        // 数据加载完成后再启动 WebSocket
        if (!isCancelled) {
          wsRef.current = new BinanceWebSocket(currentSymbol, currentTimeframe, (candle, isClosed) => {
            // 再次检查是否已取消
            if (isCancelled) return;

            updateCandle(candle);

            if (candleSeriesRef.current) {
              candleSeriesRef.current.update({
                time: candle.time as Time,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
              });
            }

            // 更新折线图
            if (highLineSeriesRef.current) {
              highLineSeriesRef.current.update({
                time: candle.time as Time,
                value: candle.high,
              });
            }
            if (lowLineSeriesRef.current) {
              lowLineSeriesRef.current.update({
                time: candle.time as Time,
                value: candle.low,
              });
            }

            if (isClosed) {
              // Recalculate indicators when a candle closes
              const updatedCandles = useChartStore.getState().candles;
              calculateIndicators(updatedCandles);
            }
          });

          wsRef.current.connect();
          setConnected(true);
        }
      } catch (error) {
        if (!isCancelled) {
          console.error("Failed to load klines:", error);
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    loadData();

    return () => {
      isCancelled = true;
      if (wsRef.current) {
        wsRef.current.disconnect();
        wsRef.current = null;
        setConnected(false);
      }
    };
  }, [symbol, timeframe, setCandles, updateCandle, setLoading, setConnected, calculateIndicators]);

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
      const limit = (symbol === "BTCUSDC" || symbol === "ETHUSDC") ? 5000 : 1000;

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
          const swings = detectSwingPoints(data);

          // OTE
          const otes = detectOTEZones(swings, lastPrice, data);
          setMultiTimeframeOTE(tf, otes[0] || null);

          // FVG
          const fvgs = detectFVGs(data);
          setMultiTimeframeFVG(tf, fvgs[fvgs.length - 1] || null);

          // OB
          const obs = detectOrderBlocks(data);
          const sortedObs = [...obs].sort((a, b) => b.startTime - a.startTime);
          setMultiTimeframeOB(tf, sortedObs[0] || null);

          // Trend
          const { bos, choch } = detectStructure(swings, lastPrice);
          let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
          if (choch.length > 0) {
            trend = choch[choch.length - 1].type;
          } else if (bos.length > 0) {
            trend = bos[bos.length - 1].type;
          }
          setMultiTimeframeTrend(tf, trend);
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
  }, [symbol, timeframe, setMultiTimeframeOTE, setMultiTimeframeFVG, setMultiTimeframeOB, setMultiTimeframeTrend]);

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

    // Update Liquidity Primitive
    if (liquidityPrimitiveRef.current) {
      if (enabled.liquidityZones) {
        liquidityPrimitiveRef.current.setData(liquidityZones);
      } else {
        liquidityPrimitiveRef.current.setData([]);
      }
    }

    // Update Killzone Primitive
    if (killzonePrimitiveRef.current) {
      killzonePrimitiveRef.current.setEnabled(enabled.killzones);
      // Set candle interval based on timeframe
      const intervalMap: Record<string, number> = {
        '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
        '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800,
        '12h': 43200, '1d': 86400, '1w': 604800,
      };
      killzonePrimitiveRef.current.setCandleInterval(intervalMap[timeframe] || 3600);
    }

    // Update OTE Primitive
    if (otePrimitiveRef.current) {
      if (enabled.ote) {
        otePrimitiveRef.current.setData(oteZones);
      } else {
        otePrimitiveRef.current.setData([]);
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
  }, [orderBlocks, fvgs, liquidityZones, oteZones, breakerBlocks, liquidationData, enabled.orderBlocks, enabled.fvg, enabled.liquidityZones, enabled.killzones, enabled.ote, enabled.breakerBlocks, timeframe]);

  // Update Swing Points Markers (蜡烛图模式)
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    if (enabled.swingPoints && swingPoints.length > 0) {
      const markers: SeriesMarker<Time>[] = swingPoints.map((sp) => ({
        time: sp.time as Time,
        position: sp.type === "high" ? "aboveBar" : "belowBar",
        color: sp.type === "high" ? "#22c55e" : "#ef4444",
        shape: sp.type === "high" ? "arrowDown" : "arrowUp",
        text: sp.type === "high" ? "HH" : "LL",
      }));
      candleSeriesRef.current.setMarkers(markers);
    } else {
      candleSeriesRef.current.setMarkers([]);
    }
  }, [swingPoints, enabled.swingPoints]);

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
        // 高线系列标记 HH/LH (局部高点)
        const highMarkers: SeriesMarker<Time>[] = classifiedPivots
          .filter((sp) => sp.type === "high")
          .map((sp) => ({
            time: sp.time as Time,
            position: "inBar" as const,
            color: sp.classification === "HH" ? "#22c55e" : "#f97316", // HH=绿色, LH=橙色
            shape: "circle" as const,
            text: sp.classification, // 显示 HH 或 LH
          }));

        // 低线系列标记 HL/LL (局部低点)
        const lowMarkers: SeriesMarker<Time>[] = classifiedPivots
          .filter((sp) => sp.type === "low")
          .map((sp) => ({
            time: sp.time as Time,
            position: "inBar" as const,
            color: sp.classification === "HL" ? "#22c55e" : "#f97316", // HL=绿色, LL=橙色
            shape: "circle" as const,
            text: sp.classification, // 显示 HL 或 LL
          }));

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

  // Update Trading Lines (Entry, Stop Loss, Take Profit, Orders, Positions)
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
    <div
      ref={chartContainerRef}
      className="w-full h-full relative"
      style={{ minHeight: "400px", cursor: getCursor() }}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
    >
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
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-2">
        <OTEPanel />
        <FVGPanel />
        <OBPanel />
        <LiquidationPanel />
        <LiquidationCGPanel />
        {user?.role === 'admin' && <LiquidityGridPanel />}
      </div>
      <MeasurementTool />
    </div>
  );
}
