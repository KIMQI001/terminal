'use client';

import { useState, useEffect, useRef } from 'react';
import { Activity, X, RefreshCw, ChevronDown, ChevronUp, Move, TrendingUp, TrendingDown } from 'lucide-react';
import { useChartStore } from '@/stores/chartStore';
import { useAgentStore, HLLevel } from '@/stores/agentStore';
import { detectSwingPoints } from '@/lib/chart/indicators/swingPoints';
import type { SwingPoint, Candle } from '@/types/chart';

interface InlineAIDisplayProps {
  symbol?: string;
}

// 计算单个周期的 HL 水平
function calculateHLLevels(candles: Candle[], timeframe: string, currentPrice: number): HLLevel[] {
  if (candles.length < 10) return [];

  const swings: SwingPoint[] = detectSwingPoints(candles, 5);

  return swings
    .filter((sp) => sp.type === 'low')
    .slice(-5)
    .map((sp): HLLevel => {
      const distance = ((currentPrice - sp.price) / currentPrice) * 100;
      let status: HLLevel['status'];

      if (currentPrice > sp.price * 1.001) {
        status = 'broken';
      } else if (currentPrice < sp.price * 0.999) {
        status = 'below';
      } else {
        status = 'approaching';
      }

      return {
        price: sp.price,
        time: sp.time,
        type: 'hl',
        timeframe,
        distance,
        status,
      };
    })
    .filter((hl) => hl.price < currentPrice && hl.distance < 5);
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

  // 监听 K 线数据变化，更新 HL 水平
  useEffect(() => {
    if (candles.length > 10) {
      updateHLLevels();
    }
  }, [candles, timeframe]);

  // 更新 HL 水平线（按周期分组）
  const updateHLLevels = async () => {
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

    // 获取各周期 K 线数据
    const allHLs: HLLevel[] = [];

    for (const tf of monitorTimeframes) {
      try {
        const res = await fetch(`/api/klines?symbol=${symbol}&interval=${tf}&limit=200`);
        if (res.ok) {
          const data = await res.json();
          if (data.candles && data.candles.length > 10) {
            const tfPrice = data.candles[data.candles.length - 1].close;
            const levels = calculateHLLevels(data.candles, tf, tfPrice);
            allHLs.push(...levels);
          }
        }
      } catch (e) {
        console.error(`Failed to fetch ${tf} klines:`, e);
      }
    }

    // 当前周期的 HL 用实时数据
    const currentLevels = calculateHLLevels(candles, timeframeRef.current, price);
    allHLs.push(...currentLevels);

    // 去重并按距离排序
    const uniqueHLs = allHLs
      .filter((hl, idx, arr) => arr.findIndex(h => h.price === hl.price) === idx)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10); // 最多显示 10 个

    setHLLevels(uniqueHLs);
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

  // 获取状态图标
  const getStatusIcon = (status: HLLevel['status']) => {
    switch (status) {
      case 'broken':
        return <TrendingUp className="w-3 h-3 text-green-500" />;
      case 'approaching':
        return <Activity className="w-3 h-3 text-yellow-500 animate-pulse" />;
      case 'below':
        return <TrendingDown className="w-3 h-3 text-gray-400" />;
      default:
        return null;
    }
  };

  const getStatusText = (status: HLLevel['status']) => {
    switch (status) {
      case 'broken':
        return '已突破';
      case 'approaching':
        return '接近中';
      case 'below':
        return '等待回踩';
      default:
        return '';
    }
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
            onClick={updateHLLevels}
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
          <div className="mb-3 pb-2 border-b border-[var(--border-color)]">
            <div className="text-xs text-[var(--text-secondary)] mb-1">当前价格</div>
            <div className="text-xl font-bold text-green-500">
              ${currentPrice ? formatPrice(currentPrice) : '--'}
            </div>
          </div>

          {/* HL 水平线列表 */}
          <div>
            <div className="text-xs text-[var(--text-secondary)] mb-2">
              HL 支撑位 (多周期)
            </div>
            {hlLevels.length > 0 ? (
              <div className="space-y-2">
                {hlLevels.map((hl, idx) => (
                  <div
                    key={idx}
                    className={`flex items-center justify-between p-2 rounded ${
                      hl.status === 'approaching'
                        ? 'bg-yellow-500/10 border border-yellow-500/30'
                        : hl.status === 'broken'
                        ? 'bg-green-500/10 border border-green-500/30'
                        : 'bg-[var(--bg-secondary)]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {getStatusIcon(hl.status)}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-mono font-medium">
                            ${formatPrice(hl.price)}
                          </span>
                          <span className={`text-xs ${getTimeframeColor(hl.timeframe)}`}>
                            {hl.timeframe}
                          </span>
                        </div>
                        <div className="text-xs text-[var(--text-secondary)]">
                          {formatTime(hl.time)}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`text-xs font-medium ${
                        hl.status === 'broken' ? 'text-green-500' :
                        hl.status === 'approaching' ? 'text-yellow-500' :
                        'text-[var(--text-secondary)]'
                      }`}>
                        {getStatusText(hl.status)}
                      </div>
                      <div className="text-xs text-[var(--text-secondary)]">
                        距离 {hl.distance.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-[var(--text-secondary)] text-center py-4">
                暂无 HL 支撑位
              </div>
            )}
          </div>

          {/* 图例说明 */}
          <div className="mt-3 pt-2 border-t border-[var(--border-color)]">
            <div className="flex items-center gap-4 text-xs text-[var(--text-secondary)]">
              <div className="flex items-center gap-1">
                <TrendingUp className="w-3 h-3 text-green-500" />
                <span>已突破</span>
              </div>
              <div className="flex items-center gap-1">
                <Activity className="w-3 h-3 text-yellow-500" />
                <span>接近中</span>
              </div>
              <div className="flex items-center gap-1">
                <TrendingDown className="w-3 h-3 text-gray-400" />
                <span>等待回踩</span>
              </div>
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
