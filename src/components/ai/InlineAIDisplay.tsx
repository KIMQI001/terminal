'use client';

import { useState, useEffect, useRef } from 'react';
import { Activity, X, RefreshCw, ChevronDown, ChevronUp, Move, TrendingUp, TrendingDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useChartStore } from '@/stores/chartStore';
import { useAgentStore, HLLevel } from '@/stores/agentStore';
import { detectSwingPoints } from '@/lib/chart/indicators/swingPoints';
import type { SwingPoint, Candle } from '@/types/chart';

interface InlineAIDisplayProps {
  symbol?: string;
}

// 计算单周期所有摆动点
function calculateSwingLevels(candles: Candle[], timeframe: string, currentPrice: number): HLLevel[] {
  if (candles.length < 10) return [];

  const swings: SwingPoint[] = detectSwingPoints(candles, 5);
  const price = candles[candles.length - 1].close;

  // 分离高低点并排序
  const highs = swings.filter(sp => sp.type === 'high').slice(-8);
  const lows = swings.filter(sp => sp.type === 'low').slice(-8);

  // 分类 HH/HL/LH/LL
  const results: HLLevel[] = [];

  // 高点：与前一个高点比较
  for (let i = 1; i < highs.length; i++) {
    const sp = highs[i];
    const prevSp = highs[i - 1];
    const isHigherHigh = sp.price > prevSp.price;
    const distance = Math.abs((price - sp.price) / price) * 100;

    let status: HLLevel['status'];
    if (price > sp.price * 1.001) {
      status = 'broken';
    } else if (price < sp.price * 0.999) {
      status = 'below';
    } else {
      status = 'approaching';
    }

    results.push({
      price: sp.price,
      time: sp.time,
      type: isHigherHigh ? 'hh' : 'lh',
      timeframe,
      distance,
      status,
      category: 'resistance',
    });
  }

  // 低点：与前一个低点比较
  for (let i = 1; i < lows.length; i++) {
    const sp = lows[i];
    const prevSp = lows[i - 1];
    const isHigherLow = sp.price > prevSp.price;
    const distance = Math.abs((price - sp.price) / price) * 100;

    let status: HLLevel['status'];
    if (price < sp.price * 0.999) {
      status = 'broken';
    } else if (price > sp.price * 1.001) {
      status = 'above';
    } else {
      status = 'approaching';
    }

    results.push({
      price: sp.price,
      time: sp.time,
      type: isHigherLow ? 'hl' : 'll',
      timeframe,
      distance,
      status,
      category: 'support',
    });
  }

  return results;
}

export function InlineAIDisplay({ symbol = 'BTC' }: InlineAIDisplayProps) {
  const timeframeRef = useRef('15m');
  const { timeframe, candles } = useChartStore();
  const {
    inlineAIEnabled,
    setInlineAIEnabled,
    currentPrice,
    hlLevels,
    setCurrentPrice,
    setHLLevels,
  } = useAgentStore();

  const [isVisible, setIsVisible] = useState(true);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // 拖拽状态
  const [position, setPosition] = useState({ x: 16, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

  // 同步 timeframe 到 ref
  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  // 监听 K 线数据变化，更新水平
  useEffect(() => {
    if (candles.length > 10) {
      updateSwingLevels();
    }
  }, [candles, timeframe]);

  // 更新摆动点水平
  const updateSwingLevels = async () => {
    const price = candles[candles.length - 1]?.close;
    if (!price) return;

    setCurrentPrice(price);

    // 根据当前周期确定要监控的级别
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

    const allLevels: HLLevel[] = [];

    for (const tf of monitorTimeframes) {
      try {
        let tfCandles: Candle[];

        if (tf === currentTf) {
          tfCandles = candles;
        } else {
          const res = await fetch(`/api/klines?symbol=${symbol}&interval=${tf}&limit=200`);
          if (res.ok) {
            const data = await res.json();
            tfCandles = data.candles;
          } else {
            continue;
          }
        }

        if (tfCandles && tfCandles.length > 10) {
          const tfPrice = tfCandles[tfCandles.length - 1].close;
          const levels = calculateSwingLevels(tfCandles, tf, tfPrice);
          allLevels.push(...levels);
        }
      } catch (e) {
        console.error(`Failed to fetch ${tf} klines:`, e);
      }
    }

    // 去重（同一价格只保留一个）
    const uniqueLevels = allLevels
      .filter((level, idx, arr) => arr.findIndex(l => Math.abs(l.price - level.price) < 1) === idx)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 12);

    setHLLevels(uniqueLevels);
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
    });
  };

  // 周期颜色
  const getTimeframeColor = (tf: string) => {
    switch (tf) {
      case '15m': return 'text-blue-400';
      case '1h': return 'text-purple-400';
      case '4h': return 'text-orange-400';
      case '1d': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  // 类型标签
  const getTypeLabel = (type: HLLevel['type']) => {
    switch (type) {
      case 'hh': return 'HH';
      case 'hl': return 'HL';
      case 'lh': return 'LH';
      case 'll': return 'LL';
    }
  };

  // 类型颜色
  const getTypeColor = (type: HLLevel['type'], category: HLLevel['category']) => {
    if (category === 'resistance') {
      return type === 'hh' ? 'text-red-400' : 'text-orange-400';
    } else {
      return type === 'hl' ? 'text-green-400' : 'text-cyan-400';
    }
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

  // 分类显示：上方压力是 LH，下方支撑是 HL
  const upperResistance = hlLevels.filter(l => l.type === 'lh'); // 上方压力 = LH
  const lowerSupport = hlLevels.filter(l => l.type === 'hl');   // 下方支撑 = HL

  // 压力位按价格从低到高排序（接近价格的在前）
  const sortedResistance = [...upperResistance].sort((a, b) => b.price - a.price);
  // 支撑位按价格从高到低排序（接近价格的在前）
  const sortedSupport = [...lowerSupport].sort((a, b) => b.price - a.price);

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
          <span className="text-sm font-medium">实时监控</span>
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
            onClick={updateSwingLevels}
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
        <div className="p-3 max-h-[450px] overflow-y-auto">
          {/* 当前价格 */}
          <div className="mb-3 pb-2 border-b border-[var(--border-color)]">
            <div className="flex items-center justify-between">
              <div className="text-xs text-[var(--text-secondary)]">当前价格</div>
              <div className="text-xs text-[var(--text-secondary)]">
                {timeframeRef.current}
              </div>
            </div>
            <div className="text-xl font-bold text-green-500">
              ${currentPrice ? formatPrice(currentPrice) : '--'}
            </div>
          </div>

          {/* 上方压力位 - LH (更低高点) */}
          <div className="mb-3">
            <div className="flex items-center gap-1 mb-2 text-xs text-[var(--text-secondary)]">
              <ArrowUp className="w-3 h-3 text-red-400" />
              <span>上方压力 (LH)</span>
            </div>
            {sortedResistance.length > 0 ? (
              <div className="space-y-1">
                {sortedResistance
                  .slice(0, 4)
                  .map((level, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center justify-between p-2 rounded text-xs ${
                        level.status === 'approaching'
                          ? 'bg-yellow-500/10 border border-yellow-500/30'
                          : 'bg-[var(--bg-secondary)]'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-orange-400 font-mono font-medium">LH</span>
                        <span className={`text-xs ${getTimeframeColor(level.timeframe)}`}>
                          {level.timeframe}
                        </span>
                        <span className="font-mono">
                          ${formatPrice(level.price)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`${level.status === 'broken' ? 'text-green-500' : level.status === 'approaching' ? 'text-yellow-500' : 'text-[var(--text-secondary)]'}`}>
                          {level.status === 'broken' ? '已突破' : level.status === 'approaching' ? '接近' : `+${level.distance.toFixed(1)}%`}
                        </span>
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="text-xs text-[var(--text-secondary)] text-center py-2">暂无压力位</div>
            )}
          </div>

          {/* 下方支撑位 - HL (更高低点) */}
          <div>
            <div className="flex items-center gap-1 mb-2 text-xs text-[var(--text-secondary)]">
              <ArrowDown className="w-3 h-3 text-green-400" />
              <span>下方支撑 (HL)</span>
            </div>
            {sortedSupport.length > 0 ? (
              <div className="space-y-1">
                {sortedSupport
                  .slice(0, 4)
                  .map((level, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center justify-between p-2 rounded text-xs ${
                        level.status === 'approaching'
                          ? 'bg-yellow-500/10 border border-yellow-500/30'
                          : 'bg-[var(--bg-secondary)]'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-green-400 font-mono font-medium">HL</span>
                        <span className={`text-xs ${getTimeframeColor(level.timeframe)}`}>
                          {level.timeframe}
                        </span>
                        <span className="font-mono">
                          ${formatPrice(level.price)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`${level.status === 'broken' ? 'text-red-500' : level.status === 'approaching' ? 'text-yellow-500' : 'text-[var(--text-secondary)]'}`}>
                          {level.status === 'broken' ? '已跌破' : level.status === 'approaching' ? '接近' : `-${level.distance.toFixed(1)}%`}
                        </span>
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="text-xs text-[var(--text-secondary)] text-center py-2">暂无支撑位</div>
            )}
          </div>

          {/* 图例 */}
          <div className="mt-3 pt-2 border-t border-[var(--border-color)]">
            <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)] flex-wrap">
              <span><span className="text-orange-400">LH</span>更低高点(压力)</span>
              <span><span className="text-green-400">HL</span>更高低点(支撑)</span>
            </div>
            <div className="flex items-center gap-3 mt-2 text-xs text-[var(--text-secondary)]">
              <span className="text-blue-400">15m</span>
              <span className="text-purple-400">1h</span>
              <span className="text-orange-400">4h</span>
              <span className="text-red-400">1d</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
