'use client';

import { useEffect } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import { Play, Pause, Settings, Bell, BellOff, Clock } from 'lucide-react';

interface AgentControlProps {
  className?: string;
}

export function AgentControl({ className = '' }: AgentControlProps) {
  const {
    isRunning,
    lastRunTime,
    interval,
    symbols,
    lastAnalysis,
    dingtalkEnabled,
    setRunning,
    setInterval: setAgentInterval,
    setDingtalkEnabled,
  } = useAgentStore();

  // 定时执行
  useEffect(() => {
    if (!isRunning) return;

    const runAnalysis = async () => {
      try {
        const response = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'analyze',
            symbol: symbols[0] || 'BTC',
            interval: '15m',
            dingtalk: dingtalkEnabled,
          }),
        });
        const result = await response.json();
        if (result.success) {
          useAgentStore.getState().setLastAnalysis(result.analysis);
          useAgentStore.getState().setLastRunTime(Date.now());
        }
      } catch (error) {
        console.error('Agent analysis failed:', error);
      }
    };

    // 立即执行一次
    runAnalysis();

    // 设置定时器
    const timerId = window.setInterval(() => runAnalysis(), interval * 60 * 1000);
    return () => window.clearInterval(timerId);
  }, [isRunning, interval, symbols, dingtalkEnabled]);

  const formatLastRun = () => {
    if (!lastRunTime) return '从未运行';
    const diff = Date.now() - lastRunTime;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    return `${Math.floor(diff / 3600000)} 小时前`;
  };

  return (
    <div className={`bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg ${className}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border-color)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
            <span className="font-medium">自主代理</span>
          </div>
          <button
            onClick={() => setRunning(!isRunning)}
            className={`p-2 rounded-lg transition-colors ${
              isRunning
                ? 'bg-red-500 hover:bg-red-600 text-white'
                : 'bg-green-500 hover:bg-green-600 text-white'
            }`}
          >
            {isRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Settings */}
      <div className="p-4 space-y-4">
        {/* Interval */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[var(--text-secondary)]" />
            <span className="text-sm">分析间隔</span>
          </div>
          <select
            value={interval}
            onChange={e => setAgentInterval(Number(e.target.value))}
            className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded px-2 py-1 text-sm"
          >
            <option value={5}>5 分钟</option>
            <option value={15}>15 分钟</option>
            <option value={30}>30 分钟</option>
            <option value={60}>1 小时</option>
          </select>
        </div>

        {/* DingTalk */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {dingtalkEnabled ? (
              <Bell className="w-4 h-4 text-green-500" />
            ) : (
              <BellOff className="w-4 h-4 text-gray-400" />
            )}
            <span className="text-sm">钉钉通知</span>
          </div>
          <button
            onClick={() => setDingtalkEnabled(!dingtalkEnabled)}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              dingtalkEnabled ? 'bg-green-500' : 'bg-gray-600'
            }`}
          >
            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
              dingtalkEnabled ? 'left-5' : 'left-0.5'
            }`} />
          </button>
        </div>

        {/* Status */}
        <div className="pt-2 border-t border-[var(--border-color)]">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>监控: {symbols.join(', ')}</span>
            <span>上次运行: {formatLastRun()}</span>
          </div>
        </div>

        {/* Last Analysis Preview */}
        {lastAnalysis && (
          <div className="pt-2 border-t border-[var(--border-color)]">
            <p className="text-xs text-[var(--text-secondary)] mb-1">最近分析:</p>
            <p className="text-sm line-clamp-3">{lastAnalysis}</p>
          </div>
        )}
      </div>
    </div>
  );
}
