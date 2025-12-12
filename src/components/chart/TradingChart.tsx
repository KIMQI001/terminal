"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  Time,
  SeriesMarker,
  IPriceLine,
} from "lightweight-charts";
import { useChartStore } from "@/stores/chartStore";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useMeasurementStore } from "@/stores/measurementStore";
import { useOrderStore } from "@/stores/orderStore";
import { usePositionStore } from "@/stores/positionStore";
import { MeasurementTool } from "./MeasurementTool";
import { ICTOverlay } from "./ICTOverlay";
import { OTEPanel } from "./OTEPanel";
import { FVGPanel } from "./FVGPanel";
import { LiquidationPanel } from "./LiquidationPanel";
import { LiquidityGridPanel } from "./LiquidityGridPanel";
import { OBPanel } from "./OBPanel";
import { DailyHLPanel } from "./DailyHLPanel";
import { OrderCancelOverlay } from "./OrderCancelOverlay";
import { fetchKlines } from "@/lib/binance/api";
import { BinanceWebSocket } from "@/lib/binance/websocket";
import { detectSwingPoints } from "@/lib/chart/indicators/swingPoints";
import { detectOrderBlocks } from "@/lib/chart/indicators/orderBlocks";
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
    candles,
    liquidationData,
    setCandles,
    updateCandle,
    setLoading,
    setConnected,
  } = useChartStore();

  const {
    enabled,
    swingPoints,
    orderBlocks,
    fvgs,
    liquidityZones,
    oteZones,
    breakerBlocks,
    setSwingPoints,
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

      // Swing points (needed for other indicators)
      // 使用 leftBars=10, rightBars=10, minSwingPercent=1.5%（TradingView 风格）
      const detectedSwingPoints = detectSwingPoints(candleData);
      setSwingPoints(detectedSwingPoints);

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
      const { bos, choch } = detectStructure(detectedSwingPoints, lastPriceForStructure);
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
        const zones = detectLiquidityZones(candleData, detectedSwingPoints);
        setLiquidityZones(zones);
      }

      // OTE zones 始终计算（面板需要数据）
      const lastPrice = candleData[candleData.length - 1].close;
      const otes = detectOTEZones(detectedSwingPoints, lastPrice, candleData);
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
        const inducements = detectInducements(candleData, detectedSwingPoints);
        setInducements(inducements);
      }
    },
    [enabled, timeframe, setSwingPoints, setOrderBlocks, setFVGs, setBOSSignals, setCHoCHSignals, setLiquidityZones, setOTEZones, setBreakerBlocks, setInducements, setMultiTimeframeOTE, setMultiTimeframeFVG, setMultiTimeframeOB, setMultiTimeframeTrend]
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
          // 转换为上海时间 (UTC+8)
          const date = new Date(timestamp * 1000);
          const shanghaiOffset = 8 * 60;
          const localOffset = date.getTimezoneOffset();
          const shanghaiTime = new Date(date.getTime() + (shanghaiOffset + localOffset) * 60 * 1000);

          const month = String(shanghaiTime.getMonth() + 1).padStart(2, '0');
          const day = String(shanghaiTime.getDate()).padStart(2, '0');
          const hours = String(shanghaiTime.getHours()).padStart(2, '0');
          const minutes = String(shanghaiTime.getMinutes()).padStart(2, '0');

          return `${month}-${day} ${hours}:${minutes}`;
        },
      },
      localization: {
        timeFormatter: (timestamp: number) => {
          // 转换为上海时间 (UTC+8)
          const date = new Date(timestamp * 1000);
          const shanghaiOffset = 8 * 60; // UTC+8 in minutes
          const localOffset = date.getTimezoneOffset();
          const shanghaiTime = new Date(date.getTime() + (shanghaiOffset + localOffset) * 60 * 1000);

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
          const chartData: CandlestickData<Time>[] = data.map((c) => ({
            time: c.time as Time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          }));
          candleSeriesRef.current.setData(chartData);

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

  // 初始化所有周期的 OTE 数据
  useEffect(() => {
    const allTimeframes = ['5m', '15m', '1h', '4h', '1d'] as const;

    const loadAllTimeframesOTE = async () => {
      for (const tf of allTimeframes) {
        // 跳过当前周期（已经由主数据加载处理）
        if (tf === timeframe) continue;

        try {
          const limit = (symbol === "BTCUSDC" || symbol === "ETHUSDC") ? 5000 : 1000;
          const data = await fetchKlines(symbol, tf, limit);

          if (data.length > 0) {
            // 检测 swing points
            const swings = detectSwingPoints(data);
            // 检测 OTE
            const lastPrice = data[data.length - 1].close;
            const otes = detectOTEZones(swings, lastPrice, data);
            // 保存到 store
            setMultiTimeframeOTE(tf, otes[0] || null);
          }
        } catch (error) {
          console.error(`Failed to load OTE for ${tf}:`, error);
        }
      }
    };

    // OTE 面板始终需要数据
    loadAllTimeframesOTE();
  }, [symbol, timeframe, setMultiTimeframeOTE]);

  // 初始化所有周期的 FVG 数据
  useEffect(() => {
    const allTimeframes = ['5m', '15m', '1h', '4h', '1d'] as const;

    const loadAllTimeframesFVG = async () => {
      for (const tf of allTimeframes) {
        // 跳过当前周期（已经由主数据加载处理）
        if (tf === timeframe) continue;

        try {
          const limit = (symbol === "BTCUSDC" || symbol === "ETHUSDC") ? 5000 : 1000;
          const data = await fetchKlines(symbol, tf, limit);

          if (data.length > 0) {
            // 检测 FVG
            const fvgs = detectFVGs(data);
            // 保存到 store（只保存最新的一个）
            setMultiTimeframeFVG(tf, fvgs[fvgs.length - 1] || null);
          }
        } catch (error) {
          console.error(`Failed to load FVG for ${tf}:`, error);
        }
      }
    };

    // FVG 面板始终需要数据
    loadAllTimeframesFVG();
  }, [symbol, timeframe, setMultiTimeframeFVG]);

  // 初始化所有周期的 OB 数据
  useEffect(() => {
    const allTimeframes = ['5m', '15m', '1h', '4h', '1d'] as const;

    const loadAllTimeframesOB = async () => {
      for (const tf of allTimeframes) {
        // 跳过当前周期（已经由主数据加载处理）
        if (tf === timeframe) continue;

        try {
          const limit = (symbol === "BTCUSDC" || symbol === "ETHUSDC") ? 5000 : 1000;
          const data = await fetchKlines(symbol, tf, limit);

          if (data.length > 0) {
            // 检测 Order Blocks
            const obs = detectOrderBlocks(data);
            // 保存到 store（按时间排序取最新的一个）
            const sortedObs = [...obs].sort((a, b) => b.startTime - a.startTime);
            setMultiTimeframeOB(tf, sortedObs[0] || null);
          }
        } catch (error) {
          console.error(`Failed to load OB for ${tf}:`, error);
        }
      }
    };

    // OB 面板始终需要数据
    loadAllTimeframesOB();
  }, [symbol, timeframe, setMultiTimeframeOB]);

  // 初始化所有周期的 Trend 数据（每 2 分钟刷新）
  useEffect(() => {
    const allTimeframes = ['5m', '15m', '1h', '4h', '1d'] as const;

    const loadAllTimeframesTrend = async () => {
      for (const tf of allTimeframes) {
        // 跳过当前周期（已经由主数据加载处理）
        if (tf === timeframe) continue;

        try {
          const limit = (symbol === "BTCUSDC" || symbol === "ETHUSDC") ? 5000 : 1000;
          const data = await fetchKlines(symbol, tf, limit);

          if (data.length > 0) {
            // 检测 swing points
            const swings = detectSwingPoints(data);
            // 检测 BOS/CHoCH
            const lastPrice = data[data.length - 1].close;
            const { bos, choch } = detectStructure(swings, lastPrice);
            // 计算趋势
            let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
            if (choch.length > 0) {
              trend = choch[choch.length - 1].type;
            } else if (bos.length > 0) {
              trend = bos[bos.length - 1].type;
            }
            setMultiTimeframeTrend(tf, trend);
          }
        } catch (error) {
          console.error(`Failed to load Trend for ${tf}:`, error);
        }
      }
    };

    // 初始加载
    loadAllTimeframesTrend();

    // 每 2 分钟刷新一次
    const interval = setInterval(loadAllTimeframesTrend, 2 * 60 * 1000);

    return () => clearInterval(interval);
  }, [symbol, timeframe, setMultiTimeframeTrend]);

  // 加载日K计算前高前低 (H/L)
  const { setDailyHL, dailyHL } = useChartStore();

  useEffect(() => {
    let isCancelled = false;

    const calculateDailyHL = async () => {
      try {
        // 获取日K数据 (100根足够)
        const dailyData = await fetchKlines(symbol, '1d', 100);
        if (isCancelled || dailyData.length < 2) return;

        // 获取当前价格（最新K线收盘价）
        const currentPrice = dailyData[dailyData.length - 1].close;
        const todayCandle = dailyData[dailyData.length - 1];

        // 从倒数第二根K线向左扫描，找到包含当前价格的K线
        for (let i = dailyData.length - 2; i >= 0; i--) {
          const candle = dailyData[i];
          // 当前价格在这根K线的高低点范围内
          if (currentPrice >= candle.low && currentPrice <= candle.high) {
            // 找到锚定K线，计算 H 和 L
            const high = Math.max(candle.high, todayCandle.high);
            const low = Math.min(candle.low, todayCandle.low);

            if (!isCancelled) {
              setDailyHL({
                high,
                low,
                anchorTime: candle.time,
              });
            }
            return;
          }
        }

        // 如果没找到（当前价格已突破所有历史K线范围），清空
        if (!isCancelled) {
          setDailyHL(null);
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

  // Update Swing Points Markers
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
        const priceLine = candleSeriesRef.current.createPriceLine({
          price: order.price,
          color: order.positionSide === 'LONG' ? '#3b82f6' : '#a855f7',
          lineWidth: 1,
          lineStyle: 2, // 虚线
          axisLabelVisible: true,
          title: `限价 ${order.quantity}`,
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

    // 5. 显示日K前高前低 (H/L)
    if (dailyHL) {
      // 前高 (H) - 红色虚线
      const highLine = candleSeriesRef.current.createPriceLine({
        price: dailyHL.high,
        color: '#ef4444',  // 红色
        lineWidth: 1,
        lineStyle: 2,  // 虚线
        axisLabelVisible: true,
        title: 'H',
      });
      priceLinesRef.current.push(highLine);

      // 前低 (L) - 绿色虚线
      const lowLine = candleSeriesRef.current.createPriceLine({
        price: dailyHL.low,
        color: '#22c55e',  // 绿色
        lineWidth: 1,
        lineStyle: 2,  // 虚线
        axisLabelVisible: true,
        title: 'L',
      });
      priceLinesRef.current.push(lowLine);
    }
  }, [tradingLines, realOrders, positions, symbol, dailyHL]);

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
      {/* 顶部左侧面板 */}
      <div className="absolute top-2 left-2 z-10">
        <DailyHLPanel />
      </div>
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-2">
        <OTEPanel />
        <FVGPanel />
        <OBPanel />
        <LiquidationPanel />
        <LiquidityGridPanel />
      </div>
      <MeasurementTool />
    </div>
  );
}
