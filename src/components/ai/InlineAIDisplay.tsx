'use client';

import { useState, useEffect } from 'react';
import { Sparkles, X, RefreshCw } from 'lucide-react';

interface InlineAIDisplayProps {
  symbol?: string;
  timeframe?: string;
}

interface AIData {
  analysis: string;
  timestamp: number;
  price?: number;
  signal?: 'bullish' | 'bearish' | 'neutral';
}

export function InlineAIDisplay({ symbol = 'BTC', timeframe = '15m' }: InlineAIDisplayProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [data, setData] = useState<AIData | null>(null);

  const fetchAnalysis = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze', symbol, interval: timeframe, dingtalk: false }),
      });
      const result = await response.json();
      if (result.success) {
        setData({
          analysis: result.analysis,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error('AI analysis failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalysis();
    // 每 5 分钟自动刷新
    const interval = setInterval(fetchAnalysis, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [symbol, timeframe]);

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
        onClick={() => setIsVisible(true)}
        className="fixed top-20 left-4 bg-blue-500 text-white px-3 py-2 rounded-lg shadow-lg flex items-center gap-2 z-40 hover:bg-blue-600 transition-colors"
      >
        <Sparkles className="w-4 h-4" />
        <span className="text-sm">AI 分析</span>
      </button>
    );
  }

  return (
    <div className="fixed top-20 left-4 w-80 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-lg z-40">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] rounded-t-lg">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-medium">AI 实时分析</span>
          <span className="text-xs text-[var(--text-secondary)]">{symbol} {timeframe}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={fetchAnalysis}
            disabled={isLoading}
            className="p-1 hover:bg-[var(--bg-primary)] rounded"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setIsVisible(false)}
            className="p-1 hover:bg-[var(--bg-primary)] rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
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
    </div>
  );
}
