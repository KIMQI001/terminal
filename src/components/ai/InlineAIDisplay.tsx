'use client';

import { useState, useEffect, useRef } from 'react';
import { Sparkles, X, RefreshCw, ChevronDown, ChevronUp, Move } from 'lucide-react';
import { useChartStore } from '@/stores/chartStore';
import { useAgentStore } from '@/stores/agentStore';

interface InlineAIDisplayProps {
  symbol?: string;
}

interface AIData {
  analysis: string;
  timestamp: number;
  signal?: 'bullish' | 'bearish' | 'neutral';
}

export function InlineAIDisplay({ symbol = 'BTC' }: InlineAIDisplayProps) {
  const timeframeRef = useRef('15m');
  const { timeframe, setTimeframe } = useChartStore();
  const { inlineAIEnabled, setInlineAIEnabled } = useAgentStore();
  const [isVisible, setIsVisible] = useState(true);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [data, setData] = useState<AIData | null>(null);

  // 拖拽状态
  const [position, setPosition] = useState({ x: 16, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

  // 同步 timeframe 到 ref
  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  // 如果开关关闭，不显示
  if (!inlineAIEnabled) {
    return (
      <button
        onClick={() => setInlineAIEnabled(true)}
        className="fixed bg-blue-500 text-white px-3 py-2 rounded-lg shadow-lg flex items-center gap-2 z-40 hover:bg-blue-600 transition-colors"
        style={{ left: position.x, top: position.y }}
      >
        <Sparkles className="w-4 h-4" />
        <span className="text-sm">AI 分析</span>
      </button>
    );
  }

  const fetchAnalysis = async () => {
    if (!inlineAIEnabled) return;
    setIsLoading(true);
    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze', symbol, interval: timeframeRef.current, dingtalk: false }),
      });
      if (!response.ok) {
        console.error('AI analysis failed:', response.status);
        return;
      }
      const result = await response.json();
      if (result.success && result.analysis) {
        setData({
          analysis: result.analysis,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error('AI analysis failed:', error);
    } finally {
      if (inlineAIEnabled) setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalysis();
    // 每 5 分钟自动刷新
    const interval = setInterval(fetchAnalysis, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [symbol, timeframe]);

  // 拖拽处理
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

  const getSignalColor = (signal?: string) => {
    switch (signal) {
      case 'bullish': return 'text-green-500';
      case 'bearish': return 'text-red-500';
      default: return 'text-yellow-500';
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  if (!isVisible) {
    return (
      <button
        onClick={() => {
          setIsVisible(true);
          setInlineAIEnabled(true);
        }}
        className="fixed bg-blue-500 text-white px-3 py-2 rounded-lg shadow-lg flex items-center gap-2 z-40 hover:bg-blue-600 transition-colors"
        style={{ left: position.x, top: position.y }}
      >
        <Sparkles className="w-4 h-4" />
        <span className="text-sm">AI 分析</span>
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
          <Sparkles className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-medium">AI 实时分析</span>
          <span className="text-xs text-[var(--text-secondary)]">{symbol} {timeframe}</span>
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
            onClick={fetchAnalysis}
            disabled={isLoading}
            className="p-1 hover:bg-[var(--bg-primary)] rounded"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setInlineAIEnabled(false)}
            className="p-1 hover:bg-[var(--bg-primary)] rounded text-green-500"
            title="关闭AI分析"
          >
            <Sparkles className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsVisible(false)}
            className="p-1 hover:bg-[var(--bg-primary)] rounded"
            title="最小化"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="p-3">
          {isLoading && !data ? (
            <div className="text-center py-4 text-[var(--text-secondary)]">
              <RefreshCw className="w-6 h-6 mx-auto animate-spin" />
              <p className="text-sm mt-2">分析中...</p>
            </div>
          ) : data ? (
            <>
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{data.analysis}</p>
              <div className="mt-2 pt-2 border-t border-[var(--border-color)] flex items-center justify-between">
                <span className="text-xs text-[var(--text-secondary)]">
                  {formatTime(data.timestamp)}
                </span>
                {data.signal && (
                  <span className={`text-xs font-medium ${getSignalColor(data.signal)}`}>
                    {data.signal === 'bullish' ? '多头信号' : data.signal === 'bearish' ? '空头信号' : '中性'}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">暂无数据</p>
          )}
        </div>
      )}
    </div>
  );
}
