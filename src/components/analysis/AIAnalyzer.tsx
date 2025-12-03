"use client";

import { useState } from "react";
import { triggerAnalyze, AnalyzeResult } from "@/lib/analysis/api";

const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"];

export function AIAnalyzer() {
  const [loading, setLoading] = useState<string | null>(null);
  const [activeTimeframe, setActiveTimeframe] = useState<string | null>(null);
  const [resultsCache, setResultsCache] = useState<Record<string, AnalyzeResult>>({});
  const [error, setError] = useState<string | null>(null);

  // 当前显示的结果
  const currentResult = activeTimeframe ? resultsCache[activeTimeframe] : null;

  const handleAnalyze = async (timeframe: string, forceRefresh: boolean = false) => {
    // 如果有缓存且不是强制刷新，直接切换显示
    if (!forceRefresh && resultsCache[timeframe]) {
      setActiveTimeframe(timeframe);
      setError(null);
      return;
    }

    setLoading(timeframe);
    setActiveTimeframe(timeframe);
    setError(null);

    try {
      const data = await triggerAnalyze("BTCUSDC", timeframe);
      setResultsCache(prev => ({ ...prev, [timeframe]: data }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "分析失败");
    } finally {
      setLoading(null);
    }
  };

  const handleRefresh = () => {
    if (activeTimeframe) {
      handleAnalyze(activeTimeframe, true);
    }
  };

  const getDirectionStyle = (direction: string) => {
    switch (direction) {
      case "long":
        return "text-green-500";
      case "short":
        return "text-red-500";
      default:
        return "text-[var(--text-tertiary)]";
    }
  };

  const getDirectionText = (direction: string) => {
    switch (direction) {
      case "long":
        return "龙升 (做多)";
      case "short":
        return "蛇降 (做空)";
      default:
        return "静修 (观望)";
    }
  };

  const getConfidenceText = (confidence: string) => {
    switch (confidence) {
      case "high":
        return "天命";
      case "medium":
        return "良机";
      default:
        return "虚无";
    }
  };

  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
        <h3 className="text-base font-medium text-[var(--text-primary)] flex items-center gap-2">
          <span>⚔️ 天机推演</span>
          <span className="text-xs font-normal text-[var(--text-tertiary)]">
            选择时间周期进行 AI 分析
          </span>
        </h3>
        {/* 刷新按钮 */}
        {activeTimeframe && (
          <button
            onClick={handleRefresh}
            disabled={loading !== null}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="重新推演当前周期"
          >
            <svg
              className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Content */}
      <div className="p-4">
        {/* 时间周期按钮 */}
        <div className="flex flex-wrap gap-2 mb-4">
          {TIMEFRAMES.map((tf) => {
            const hasCache = !!resultsCache[tf];
            const isActive = activeTimeframe === tf;
            const isLoading = loading === tf;

            return (
              <button
                key={tf}
                disabled={loading !== null}
                onClick={() => handleAnalyze(tf)}
                className={`px-3 py-1.5 rounded text-sm transition-colors relative ${
                  isLoading
                    ? "bg-blue-500 text-white"
                    : isActive
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/50"
                    : hasCache
                    ? "bg-green-500/10 text-green-500 border border-green-500/30 hover:bg-green-500/20"
                    : "bg-[var(--bg-tertiary)] hover:bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)]"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {isLoading ? "推演中..." : tf.toUpperCase()}
                {/* 缓存标记 */}
                {hasCache && !isActive && !isLoading && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full" />
                )}
              </button>
            );
          })}
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* 加载中 */}
        {loading && !currentResult && (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-3"></div>
            <span className="text-[var(--text-tertiary)]">天机推演中...</span>
          </div>
        )}

        {/* 分析结果 */}
        {currentResult && (
          <div className="space-y-4">
            {/* 基本信息 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">周期</div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  {currentResult.timeframe}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">灵石价</div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  ${currentResult.currentPrice.toFixed(2)}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">天意</div>
                <div
                  className={`text-lg font-semibold ${getDirectionStyle(
                    currentResult.signal.direction
                  )}`}
                >
                  {getDirectionText(currentResult.signal.direction)}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">道心</div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  {getConfidenceText(currentResult.signal.confidence)}
                </div>
              </div>
            </div>

            {/* 交易计划（非观望时显示） */}
            {currentResult.signal.direction !== "neutral" && (
              <div className="p-4 bg-[var(--bg-tertiary)]/50 rounded-lg space-y-3">
                <h4 className="font-semibold text-[var(--text-primary)]">修炼心法</h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                  <div>
                    <span className="text-[var(--text-tertiary)]">入道: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      ${currentResult.signal.entry.price.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">渡劫线: </span>
                    <span className="font-medium text-red-500">
                      ${currentResult.signal.stopLoss.price.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">因果比: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      1:{currentResult.signal.riskReward.toFixed(1)}
                    </span>
                  </div>
                </div>
                {currentResult.signal.takeProfit.length > 0 && (
                  <div>
                    <span className="text-[var(--text-tertiary)] text-sm">
                      飞升境界:{" "}
                    </span>
                    {currentResult.signal.takeProfit.map((tp, i) => (
                      <span key={i} className="text-sm text-green-500 mr-2">
                        {i + 1}重天 ${tp.price.toFixed(2)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 分析理由 */}
            <div className="p-4 bg-[var(--bg-tertiary)]/50 rounded-lg">
              <h4 className="font-semibold text-[var(--text-primary)] mb-2">天道感悟</h4>
              <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                {currentResult.signal.reasoning}
              </p>
            </div>

            {/* 风险警示 */}
            {currentResult.signal.warnings.length > 0 && (
              <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <h4 className="font-semibold text-yellow-500 mb-2">劫难预警</h4>
                <ul className="text-sm text-yellow-500 space-y-1">
                  {currentResult.signal.warnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 时间戳 */}
            <div className="text-xs text-[var(--text-tertiary)] text-right">
              推演时间: {new Date(currentResult.timestamp).toLocaleString("zh-CN")}
            </div>
          </div>
        )}

        {/* 初始状态 */}
        {!currentResult && !error && !loading && (
          <div className="text-center text-[var(--text-tertiary)] py-8">
            点击上方周期按钮开始天机推演
          </div>
        )}
      </div>
    </div>
  );
}
