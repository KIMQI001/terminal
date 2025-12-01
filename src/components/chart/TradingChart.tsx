"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  Time,
} from "lightweight-charts";
import { useChartStore } from "@/stores/chartStore";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useMeasurementStore } from "@/stores/measurementStore";
import { MeasurementTool } from "./MeasurementTool";
import { fetchKlines } from "@/lib/binance/api";
import { BinanceWebSocket } from "@/lib/binance/websocket";
import { detectSwingPoints } from "@/lib/chart/indicators/swingPoints";
import { detectOrderBlocks } from "@/lib/chart/indicators/orderBlocks";
import { detectFVGs } from "@/lib/chart/indicators/fvg";
import { detectStructure } from "@/lib/chart/indicators/structure";
import { detectLiquidityZones } from "@/lib/chart/indicators/liquidity";
import { Candle } from "@/types/chart";

export function TradingChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const wsRef = useRef<BinanceWebSocket | null>(null);

  // Shift 键状态
  const [isShiftPressed, setIsShiftPressed] = useState(false);

  const {
    symbol,
    timeframe,
    candles,
    setCandles,
    updateCandle,
    setLoading,
    setConnected,
  } = useChartStore();

  const { enabled, setOrderBlocks, setFVGs, setBOSSignals, setCHoCHSignals, setLiquidityZones } =
    useIndicatorStore();

  const {
    phase,
    isToolActive,
    startDrawing,
    updateDrawing,
    clearMeasurement,
  } = useMeasurementStore();

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

  // 可以开始测量的条件：Shift 按下 或 工具栏激活
  const canStartMeasure = isShiftPressed || isToolActive;

  // Calculate indicators when candles change
  const calculateIndicators = useCallback(
    (candleData: Candle[]) => {
      if (candleData.length < 10) return;

      // Swing points (needed for other indicators)
      const swingPoints = detectSwingPoints(candleData, 3);

      if (enabled.orderBlocks) {
        const obs = detectOrderBlocks(candleData);
        setOrderBlocks(obs);
      }

      if (enabled.fvg) {
        const fvgs = detectFVGs(candleData);
        setFVGs(fvgs);
      }

      if (enabled.bos || enabled.choch) {
        const lastPrice = candleData[candleData.length - 1].close;
        const { bos, choch } = detectStructure(swingPoints, lastPrice);
        if (enabled.bos) setBOSSignals(bos);
        if (enabled.choch) setCHoCHSignals(choch);
      }

      if (enabled.liquidityZones) {
        const zones = detectLiquidityZones(candleData, swingPoints);
        setLiquidityZones(zones);
      }
    },
    [enabled, setOrderBlocks, setFVGs, setBOSSignals, setCHoCHSignals, setLiquidityZones]
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
    const loadData = async () => {
      setLoading(true);
      try {
        // BTC/ETH 请求 5000 根，其他交易对请求 1000 根
        const limit = (symbol === "BTCUSDC" || symbol === "ETHUSDC") ? 5000 : 1000;
        const data = await fetchKlines(symbol, timeframe, limit);
        setCandles(data);
        calculateIndicators(data);

        if (candleSeriesRef.current) {
          const chartData: CandlestickData<Time>[] = data.map((c) => ({
            time: c.time as Time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }));
          candleSeriesRef.current.setData(chartData);
        }
      } catch (error) {
        console.error("Failed to load klines:", error);
      } finally {
        setLoading(false);
      }
    };

    loadData();

    // Setup WebSocket
    if (wsRef.current) {
      wsRef.current.disconnect();
    }

    wsRef.current = new BinanceWebSocket(symbol, timeframe, (candle, isClosed) => {
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

      if (isClosed) {
        // Recalculate indicators when a candle closes
        const updatedCandles = useChartStore.getState().candles;
        calculateIndicators(updatedCandles);
      }
    });

    wsRef.current.connect();
    setConnected(true);

    return () => {
      if (wsRef.current) {
        wsRef.current.disconnect();
        setConnected(false);
      }
    };
  }, [symbol, timeframe, setCandles, updateCandle, setLoading, setConnected, calculateIndicators]);

  // Draw indicators on chart
  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || candles.length === 0) return;

    // Clear existing markers and lines
    candleSeriesRef.current.setMarkers([]);

    // We'll add indicator visualization in future iterations
    // For now, the indicators are calculated and stored in the store
  }, [candles, enabled]);

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
      <MeasurementTool />
    </div>
  );
}
