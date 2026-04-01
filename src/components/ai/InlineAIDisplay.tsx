'use client';

import { useState, useEffect, useRef } from 'react';
import { Activity, X, RefreshCw, ChevronDown, ChevronUp, Move } from 'lucide-react';
import { useChartStore } from '@/stores/chartStore';
import { useAgentStore } from '@/stores/agentStore';
import { detectSwingPoints } from '@/lib/chart/indicators/swingPoints';
import type { Candle } from '@/types/chart';

const KLINE_API = process.env.NEXT_PUBLIC_KLINE_API || 'http://localhost:3001';

// 分级别的 Pivot 点
interface PivotPoint {
  price: number;
  time: number;
}

interface LevelPivots {
  timeframe: string;
  hh: PivotPoint | null;
  lh: PivotPoint | null;
  hl: PivotPoint | null;
  ll: PivotPoint | null;
}

// 通道预测
interface ChannelPrediction {
  type: 'bullish' | 'bearish';
  d: number;
  predictions: {
    equal: number;   // 等距
    expansion: number; // 扩张 (2d)
    contract: number;  // 收敛
  };
  relatedPivots: {
    high1: { price: number; time: number; label: string };
    high2: { price: number; time: number; label: string };
    low1: { price: number; time: number; label: string };
  };
}

interface InlineAIDisplayProps {
  symbol?: string;
}

// 计算某个周期的 HH/LH/HL/LL
interface PivotSet {
  hh: PivotPoint;
  lh: PivotPoint;
  hl: PivotPoint;
  ll: PivotPoint;
}

function calculatePivots(candles: Candle[]): PivotSet | null {
  if (candles.length < 10) return null;

  const swings = detectSwingPoints(candles, 5);

  if (swings.length < 4) return null;

  // 分离高低点并按价格排序
  const highs = swings.filter(s => s.type === 'high').sort((a, b) => b.price - a.price);
  const lows = swings.filter(s => s.type === 'low').sort((a, b) => a.price - b.price);

  if (highs.length < 2 || lows.length < 2) return null;

  return {
    hh: { price: highs[0].price, time: highs[0].time },
    lh: { price: highs[1].price, time: highs[1].time },
    hl: { price: lows[1].price, time: lows[1].time },
    ll: { price: lows[0].price, time: lows[0].time },
  };
}

// 判断价格位置
function getPricePosition(price: number, pivots: LevelPivots): string {
  const { hh, lh, hl, ll } = pivots;
  if (!hh || !lh || !hl || !ll) return '未知';

  // 检查是否突破 HH
  if (price > hh.price) return '突破HH';
  // 检查是否在 HH 和 LH 之间
  if (price > lh.price && price <= hh.price) return 'HH-LH区间';
  // 检查是否在 LH 和 HL 之间
  if (price > hl.price && price <= lh.price) return 'LH-HL区间';
  // 检查是否在 HL 和 LL 之间
  if (price > ll.price && price <= hl.price) return 'HL-LL区间';
  // 检查是否跌破 LL
  if (price <= ll.price) return '跌破LL';

  return '未知';
}

export function InlineAIDisplay({ symbol = 'BTC' }: InlineAIDisplayProps) {
  const timeframeRef = useRef('15m');
  const { timeframe, candles } = useChartStore();
  const { inlineAIEnabled, setInlineAIEnabled, setCurrentPrice } = useAgentStore();

  const [isVisible, setIsVisible] = useState(true);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [multiTimeframePivots, setMultiTimeframePivots] = useState<LevelPivots[]>([]);

  // 拖拽状态
  const [position, setPosition] = useState({ x: 16, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

  // 当前价格
  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : null;

  // 计算各级别 Pivot 点
  const calculateAllPivots = async () => {
    const currentTf = timeframeRef.current;
    let monitorTimeframes: string[] = [];

    if (currentTf === '15m') {
      monitorTimeframes = ['15m', '1h', '4h'];
    } else if (currentTf === '1h') {
      monitorTimeframes = ['1h', '4h', '1d'];
    } else if (currentTf === '4h') {
      monitorTimeframes = ['4h', '1d'];
    } else {
      monitorTimeframes = [currentTf];
    }

    const allPivots: LevelPivots[] = [];

    for (const tf of monitorTimeframes) {
      try {
        let tfCandles: Candle[];

        if (tf === currentTf && candles.length > 0) {
          tfCandles = candles;
        } else {
          const res = await fetch(`${KLINE_API}/api/klines/${symbol.toUpperCase()}/${tf}?limit=500`);
          if (!res.ok) continue;
          const data = await res.json();
          tfCandles = data.klines;
        }

        if (tfCandles && tfCandles.length > 10) {
          const pivots = calculatePivots(tfCandles);
          if (pivots) {
            allPivots.push({
              timeframe: tf,
              ...pivots,
            });
          }
        }
      } catch (e) {
        console.error(`Failed to fetch ${tf} pivots:`, e);
      }
    }

    setMultiTimeframePivots(allPivots);
  };

  // 通道预测计算
  const channelPrediction: ChannelPrediction | null = (() => {
    if (!currentPrice || multiTimeframePivots.length === 0) return null;

    // 优先用当前周期的 pivots
    const currentTf = timeframeRef.current;
    const pivots = multiTimeframePivots.find(p => p.timeframe === currentTf);

    if (!pivots || !pivots.hh || !pivots.lh || !pivots.hl || !pivots.ll) return null;

    const { hh, lh, hl, ll } = pivots;

    // 通道宽度 d = 两个高点之差
    const d = hh.price - lh.price;

    if (d <= 0) return null;

    // 宽松的通道判断：价格是否在 HH-LH 区间（接近高点）
    // 或者在 HL-LL 区间（接近低点）
    const isNearHigh = currentPrice > lh.price && currentPrice <= hh.price;
    const isNearLow = currentPrice > ll.price && currentPrice <= hl.price;

    // 上升通道：价格接近低点 HL
    if (isNearLow) {
      return {
        type: 'bullish',
        d,
        predictions: {
          equal: hl.price - d,        // 等距
          expansion: hl.price - 2 * d, // 扩张
          contract: hl.price + d,      // 收敛
        },
        relatedPivots: {
          high1: { price: hh.price, time: hh.time, label: 'HH' },
          high2: { price: lh.price, time: lh.time, label: 'LH' },
          low1: { price: hl.price, time: hl.time, label: 'HL' },
        },
      };
    }

    // 下降通道：价格接近高点 LH
    if (isNearHigh) {
      const dLow = lh.price - ll.price;
      return {
        type: 'bearish',
        d: dLow,
        predictions: {
          equal: lh.price + dLow,
          expansion: lh.price + 2 * dLow,
          contract: lh.price - dLow,
        },
        relatedPivots: {
          high1: { price: lh.price, time: lh.time, label: 'LH' },
          high2: { price: hh.price, time: hh.time, label: 'HH' },
          low1: { price: ll.price, time: ll.time, label: 'LL' },
        },
      };
    }

    // 价格在其他区间，不做通道预测
    return null;
  })();

  // 价格位置判断
  const pricePosition = (() => {
    if (!currentPrice || multiTimeframePivots.length === 0) return '加载中...';

    const currentTf = timeframeRef.current;
    const pivots = multiTimeframePivots.find(p => p.timeframe === currentTf);

    if (!pivots || !pivots.hh || !pivots.lh || !pivots.hl || !pivots.ll) return '数据不足';

    return getPricePosition(currentPrice, pivots);
  })();

  // 同步 timeframe
  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  // 监听 K 线变化
  useEffect(() => {
    if (candles.length > 0) {
      const price = candles[candles.length - 1].close;
      setCurrentPrice(price);
      // 重新计算 pivot 点
      calculateAllPivots();
    }
  }, [candles, timeframe, setCurrentPrice]);

  // 定时刷新
  useEffect(() => {
    const interval = setInterval(() => {
      if (candles.length > 0) {
        calculateAllPivots();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [candles, timeframe]);

  // 刷新
  const handleRefresh = () => {
    setIsLoading(true);
    calculateAllPivots().then(() => setIsLoading(false));
  };

  // 关闭时显示按钮
  if (!inlineAIEnabled) {
    return (
      <button
        onClick={() => setInlineAIEnabled(true)}
        className="fixed bg-green-500 text-white px-3 py-2 rounded-lg shadow-lg flex items-center gap-2 z-40 hover:bg-green-600 transition-colors"
        style={{ left: position.x, top: position.y }}
      >
        <Activity className="w-4 h-4" />
        <span className="text-sm">实时监控</span>
      </button>
    );
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: position.x,
      startPosY: position.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragRef.current) return;
    setPosition({
      x: dragRef.current.startPosX + e.clientX - dragRef.current.startX,
      y: dragRef.current.startPosY + e.clientY - dragRef.current.startY,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    dragRef.current = null;
  };

  const formatPrice = (price: number) => {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  };

  const getTimeframeColor = (tf: string) => {
    switch (tf) {
      case '15m': return 'text-blue-400';
      case '1h': return 'text-purple-400';
      case '4h': return 'text-orange-400';
      case '1d': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  if (!isVisible) {
    return (
      <button
        onClick={() => { setIsVisible(true); setInlineAIEnabled(true); }}
        className="fixed bg-green-500 text-white px-3 py-2 rounded-lg shadow-lg flex items-center gap-2 z-40 hover:bg-green-600 transition-colors"
        style={{ left: position.x, top: position.y }}
      >
        <Activity className="w-4 h-4" />
        <span className="text-sm">实时监控</span>
      </button>
    );
  }

  return (
    <div
      className={`fixed bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-lg z-40 transition-shadow ${isDragging ? 'shadow-2xl cursor-grabbing' : 'cursor-grab'}`}
      style={{ left: position.x, top: position.y, width: 340 }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] rounded-t-lg select-none">
        <div className="flex items-center gap-2">
          <Move className="w-3 h-3 text-[var(--text-secondary)]" />
          <Activity className="w-4 h-4 text-green-500" />
          <span className="text-sm font-medium">实时通道监控</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setIsCollapsed(!isCollapsed)} className="p-1 hover:bg-[var(--bg-primary)] rounded">
            {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
          <button onClick={handleRefresh} disabled={isLoading} className="p-1 hover:bg-[var(--bg-primary)] rounded">
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => setInlineAIEnabled(false)} className="p-1 hover:bg-[var(--bg-primary)] rounded text-red-500">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="p-3 max-h-[500px] overflow-y-auto">
          {/* 当前价格 */}
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[10px] text-[var(--text-secondary)]">当前价格</div>
              <div className="text-xl font-bold text-green-500">
                ${currentPrice ? formatPrice(currentPrice) : '--'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-[var(--text-secondary)]">{timeframeRef.current}</div>
              <div className="text-[10px] text-yellow-400 mt-1">{pricePosition}</div>
            </div>
          </div>

          {/* 各级别 Pivot 点 */}
          <div className="space-y-3 mb-4">
            {multiTimeframePivots.map((pivots) => (
              <div key={pivots.timeframe} className="p-2 bg-[var(--bg-secondary)] rounded">
                <div className={`text-[10px] font-medium mb-2 ${getTimeframeColor(pivots.timeframe)}`}>
                  {pivots.timeframe}
                </div>
                <div className="grid grid-cols-2 gap-1 text-[10px]">
                  <div className="flex items-center gap-1">
                    <span className="text-red-400 w-5">HH</span>
                    <span className="font-mono">{pivots.hh ? formatPrice(pivots.hh.price) : '-'}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-orange-400 w-5">LH</span>
                    <span className="font-mono">{pivots.lh ? formatPrice(pivots.lh.price) : '-'}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-cyan-400 w-5">HL</span>
                    <span className="font-mono">{pivots.hl ? formatPrice(pivots.hl.price) : '-'}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-green-400 w-5">LL</span>
                    <span className="font-mono">{pivots.ll ? formatPrice(pivots.ll.price) : '-'}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 通道预测 */}
          {channelPrediction ? (
            <div className="space-y-2">
              {/* 通道类型 */}
              <div className={`p-2 rounded text-center text-xs font-medium ${
                channelPrediction.type === 'bullish'
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-red-500/20 text-red-400'
              }`}>
                {channelPrediction.type === 'bullish' ? '上升通道 (回撤买入)' : '下降通道 (反弹卖出)'}
              </div>

              {/* 通道宽度 */}
              <div className="flex items-center justify-between p-2 bg-yellow-500/10 rounded border border-yellow-500/30">
                <span className="text-[10px] text-[var(--text-secondary)]">通道宽度 d</span>
                <span className="text-sm font-mono font-medium text-yellow-400">{channelPrediction.d.toFixed(0)}</span>
              </div>

              {/* 预测点 */}
              <div className="p-2 bg-[var(--bg-secondary)] rounded">
                <div className="text-[10px] text-[var(--text-secondary)] mb-2">预测点</div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between p-1.5 bg-green-500/10 rounded text-xs">
                    <span className="text-green-400">=</span>
                    <span className="text-[var(--text-secondary)]">等距</span>
                    <span className="font-mono text-green-400">${formatPrice(channelPrediction.predictions.equal)}</span>
                  </div>
                  <div className="flex items-center justify-between p-1.5 bg-orange-500/10 rounded text-xs">
                    <span className="text-orange-400">×2</span>
                    <span className="text-[var(--text-secondary)]">扩张</span>
                    <span className="font-mono text-orange-400">${formatPrice(channelPrediction.predictions.expansion)}</span>
                  </div>
                  <div className="flex items-center justify-between p-1.5 bg-purple-500/10 rounded text-xs">
                    <span className="text-purple-400">↕</span>
                    <span className="text-[var(--text-secondary)]">收敛</span>
                    <span className="font-mono text-purple-400">${formatPrice(channelPrediction.predictions.contract)}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-3 text-xs text-[var(--text-secondary)]">
              价格在 LH-HL 区间，等待方向确认
            </div>
          )}
        </div>
      )}
    </div>
  );
}
