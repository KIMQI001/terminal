'use client';

import { useState, useEffect, useRef } from 'react';
import { Activity, X, RefreshCw, ChevronDown, ChevronUp, Move } from 'lucide-react';
import { useChartStore } from '@/stores/chartStore';
import { useAgentStore, HLLevel } from '@/stores/agentStore';
import { detectSwingPoints } from '@/lib/chart/indicators/swingPoints';
import type { SwingPoint, Candle } from '@/types/chart';

// kline-server API
const KLINE_API = process.env.NEXT_PUBLIC_KLINE_API || 'http://localhost:3001';

// 通道预测类型
interface BullishChannelPrediction {
  type: 'bullish';
  zone: 'low';
  knownPoints: {
    hh1: { price: number; time: number };
    hh2: { price: number; time: number };
    hl1: { price: number; time: number };
  };
  d: number;
  predictions: {
    hl2Equal: number;
    llExpansion: number;
    hl2Contract: number;
  };
}

interface BearishChannelPrediction {
  type: 'bearish';
  zone: 'high';
  knownPoints: {
    ll1: { price: number; time: number };
    ll2: { price: number; time: number };
    lh1: { price: number; time: number };
  };
  d: number;
  predictions: {
    lh2Equal: number;
    hhExpansion: number;
    lh2Contract: number;
  };
}

type ChannelPrediction = BullishChannelPrediction | BearishChannelPrediction | null;

interface InlineAIDisplayProps {
  symbol?: string;
}

export function InlineAIDisplay({ symbol = 'BTC' }: InlineAIDisplayProps) {
  const timeframeRef = useRef('15m');
  const { timeframe, candles } = useChartStore();
  const {
    inlineAIEnabled,
    setInlineAIEnabled,
    currentPrice,
    setCurrentPrice,
  } = useAgentStore();

  const [isVisible, setIsVisible] = useState(true);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // 拖拽状态
  const [position, setPosition] = useState({ x: 16, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

  // 通道预测分析
  const channelPrediction: ChannelPrediction = (() => {
    if (candles.length < 10) return null;

    const recent = candles.slice(-1000);
    const swings = detectSwingPoints(recent, 5);

    if (swings.length < 4) return null;

    // 分离高低点
    const highs = swings.filter(s => s.type === 'high').sort((a, b) => b.price - a.price);
    const lows = swings.filter(s => s.type === 'low').sort((a, b) => a.price - b.price);

    if (highs.length < 2 || lows.length < 2) return null;

    const hh = highs[0];
    const lh = highs[1];
    const ll = lows[0];
    const hl = lows[1];

    const price = candles[candles.length - 1].close;

    // 通道宽度 d = 两个高点之差
    const d = hh.price - lh.price;

    if (d <= 0) return null;

    // 当前价格在 HL1 附近时（低点区间）的预测 - 上升通道形态
    if (price < hl.price && price > ll.price) {
      return {
        type: 'bullish',
        zone: 'low',
        knownPoints: {
          hh1: { price: hh.price, time: hh.time },
          hh2: { price: lh.price, time: lh.time },
          hl1: { price: hl.price, time: hl.time },
        },
        d,
        predictions: {
          hl2Equal: hl.price - d,
          llExpansion: hl.price - 2 * d,
          hl2Contract: hl.price + d,
        },
      };
    }

    // 当前价格在 LH1 附近时（高点区间）的预测 - 下降通道形态
    if (price > lh.price && price < hh.price) {
      const dLow = lh.price - ll.price;
      return {
        type: 'bearish',
        zone: 'high',
        knownPoints: {
          ll1: { price: ll.price, time: ll.time },
          ll2: { price: hl.price, time: hl.time },
          lh1: { price: lh.price, time: lh.time },
        },
        d: dLow,
        predictions: {
          lh2Equal: lh.price + dLow,
          hhExpansion: lh.price + 2 * dLow,
          lh2Contract: lh.price - dLow,
        },
      };
    }

    return null;
  })();

  // 同步 timeframe 到 ref
  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  // 监听 K 线数据变化，更新价格
  useEffect(() => {
    if (candles.length > 0) {
      const price = candles[candles.length - 1].close;
      setCurrentPrice(price);
    }
  }, [candles, setCurrentPrice]);

  // 刷新价格
  const refreshPrice = () => {
    if (candles.length > 0) {
      setCurrentPrice(candles[candles.length - 1].close);
    }
  };

  // 如果开关关闭，不显示
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
    const deltaX = e.clientX - dragRef.current.startX;
    const deltaY = e.clientY - dragRef.current.startY;
    setPosition({
      x: dragRef.current.startPosX + deltaX,
      y: dragRef.current.startPosY + deltaY,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    dragRef.current = null;
  };

  const formatPrice = (price: number) => {
    return price.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!isVisible) {
    return (
      <button
        onClick={() => {
          setIsVisible(true);
          setInlineAIEnabled(true);
        }}
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
      style={{ left: position.x, top: position.y, width: 320 }}
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
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1 hover:bg-[var(--bg-primary)] rounded"
            title={isCollapsed ? '展开' : '折叠'}
          >
            {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
          <button
            onClick={refreshPrice}
            disabled={isLoading}
            className="p-1 hover:bg-[var(--bg-primary)] rounded"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setInlineAIEnabled(false)}
            className="p-1 hover:bg-[var(--bg-primary)] rounded text-red-500"
            title="关闭监控"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="p-3 max-h-[400px] overflow-y-auto">
          {/* 当前价格 */}
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[10px] text-[var(--text-secondary)]">当前价格</div>
              <div className="text-lg font-bold text-green-500">
                ${currentPrice ? formatPrice(currentPrice) : '--'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-[var(--text-secondary)]">{timeframeRef.current}</div>
              {channelPrediction && (
                <div className={`text-[10px] px-2 py-0.5 rounded mt-1 ${channelPrediction.type === 'bullish' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                  {channelPrediction.type === 'bullish' ? '上升通道' : '下降通道'}
                </div>
              )}
            </div>
          </div>

          {/* 通道监控 */}
          {channelPrediction ? (
            <div className="space-y-3">
              {/* 通道宽度 */}
              <div className="flex items-center justify-between p-2 bg-yellow-500/10 rounded border border-yellow-500/30">
                <span className="text-[10px] text-[var(--text-secondary)]">通道宽度</span>
                <span className="text-sm font-mono font-medium text-yellow-400">d = {channelPrediction.d.toFixed(0)}</span>
              </div>

              {/* 已知点 */}
              <div className="p-2 bg-[var(--bg-secondary)] rounded">
                <div className="text-[10px] text-[var(--text-secondary)] mb-2">已知点</div>
                {channelPrediction.type === 'bullish' ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-6 text-red-400 font-medium">HH1</span>
                        <span className="font-mono">{formatPrice(channelPrediction.knownPoints.hh1.price)}</span>
                      </div>
                      <span className="text-[var(--text-secondary)] text-[10px]">{formatTime(channelPrediction.knownPoints.hh1.time)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-6 text-orange-400 font-medium">HH2</span>
                        <span className="font-mono">{formatPrice(channelPrediction.knownPoints.hh2.price)}</span>
                      </div>
                      <span className="text-[var(--text-secondary)] text-[10px]">{formatTime(channelPrediction.knownPoints.hh2.time)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-6 text-cyan-400 font-medium">HL1</span>
                        <span className="font-mono">{formatPrice(channelPrediction.knownPoints.hl1.price)}</span>
                      </div>
                      <span className="text-[var(--text-secondary)] text-[10px]">{formatTime(channelPrediction.knownPoints.hl1.time)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-6 text-green-400 font-medium">LL1</span>
                        <span className="font-mono">{formatPrice(channelPrediction.knownPoints.ll1.price)}</span>
                      </div>
                      <span className="text-[var(--text-secondary)] text-[10px]">{formatTime(channelPrediction.knownPoints.ll1.time)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-6 text-cyan-400 font-medium">LL2</span>
                        <span className="font-mono">{formatPrice(channelPrediction.knownPoints.ll2.price)}</span>
                      </div>
                      <span className="text-[var(--text-secondary)] text-[10px]">{formatTime(channelPrediction.knownPoints.ll2.time)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-6 text-orange-400 font-medium">LH1</span>
                        <span className="font-mono">{formatPrice(channelPrediction.knownPoints.lh1.price)}</span>
                      </div>
                      <span className="text-[var(--text-secondary)] text-[10px]">{formatTime(channelPrediction.knownPoints.lh1.time)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* 预测点 */}
              <div className="p-2 bg-[var(--bg-secondary)] rounded">
                <div className="text-[10px] text-[var(--text-secondary)] mb-2">预测点</div>
                {channelPrediction.type === 'bullish' ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between p-1.5 bg-green-500/10 rounded text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-green-400">=</span>
                        <span className="text-[var(--text-secondary)]">等距</span>
                      </div>
                      <span className="font-mono text-green-400">${formatPrice(channelPrediction.predictions.hl2Equal)}</span>
                    </div>
                    <div className="flex items-center justify-between p-1.5 bg-orange-500/10 rounded text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-orange-400">×2</span>
                        <span className="text-[var(--text-secondary)]">扩张</span>
                      </div>
                      <span className="font-mono text-orange-400">${formatPrice(channelPrediction.predictions.llExpansion)}</span>
                    </div>
                    <div className="flex items-center justify-between p-1.5 bg-purple-500/10 rounded text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-purple-400">↕</span>
                        <span className="text-[var(--text-secondary)]">收敛</span>
                      </div>
                      <span className="font-mono text-purple-400">${formatPrice(channelPrediction.predictions.hl2Contract)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between p-1.5 bg-green-500/10 rounded text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-green-400">=</span>
                        <span className="text-[var(--text-secondary)]">等距</span>
                      </div>
                      <span className="font-mono text-green-400">${formatPrice(channelPrediction.predictions.lh2Equal)}</span>
                    </div>
                    <div className="flex items-center justify-between p-1.5 bg-orange-500/10 rounded text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-orange-400">×2</span>
                        <span className="text-[var(--text-secondary)]">扩张</span>
                      </div>
                      <span className="font-mono text-orange-400">${formatPrice(channelPrediction.predictions.hhExpansion)}</span>
                    </div>
                    <div className="flex items-center justify-between p-1.5 bg-purple-500/10 rounded text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-purple-400">↕</span>
                        <span className="text-[var(--text-secondary)]">收敛</span>
                      </div>
                      <span className="font-mono text-purple-400">${formatPrice(channelPrediction.predictions.lh2Contract)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-4 text-xs text-[var(--text-secondary)]">
              价格不在通道区间内
            </div>
          )}
        </div>
      )}
    </div>
  );
}
