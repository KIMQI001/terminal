"use client";

import { useState } from "react";
import { triggerAnalyze, triggerReversalAnalyze, AnalyzeResult, ReversalAnalyzeResult } from "@/lib/analysis/api";

const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"];

export function AIAnalyzer() {
  const [loading, setLoading] = useState<string | null>(null);
  const [activeTimeframe, setActiveTimeframe] = useState<string | null>(null);
  const [resultsCache, setResultsCache] = useState<Record<string, AnalyzeResult>>({});
  const [error, setError] = useState<string | null>(null);

  // 反转分析状态
  const [reversalMode, setReversalMode] = useState<"top" | "bottom" | null>(null);
  const [reversalCache, setReversalCache] = useState<Record<string, ReversalAnalyzeResult>>({});

  // 当前显示的结果
  const currentResult = activeTimeframe ? resultsCache[activeTimeframe] : null;
  const reversalResult = reversalMode ? reversalCache[reversalMode] : null;

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
    if (reversalMode) {
      handleReversalAnalyze(reversalMode, true);
    } else if (activeTimeframe) {
      handleAnalyze(activeTimeframe, true);
    }
  };

  // 反转分析处理
  const handleReversalAnalyze = async (mode: "top" | "bottom", forceRefresh: boolean = false) => {
    // 如果有缓存且不是强制刷新，直接切换显示
    if (!forceRefresh && reversalCache[mode]) {
      setActiveTimeframe(null);
      setReversalMode(mode);
      setError(null);
      return;
    }

    setLoading(mode === "top" ? "reversal-top" : "reversal-bottom");
    setActiveTimeframe(null);
    setReversalMode(mode);
    setError(null);

    try {
      const data = await triggerReversalAnalyze("BTCUSDC", mode);
      setReversalCache(prev => ({ ...prev, [mode]: data }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "反转分析失败");
    } finally {
      setLoading(null);
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
        {(activeTimeframe || reversalMode) && (
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
        {/* 时间周期按钮 + 反转按钮 */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {TIMEFRAMES.map((tf) => {
            const hasCache = !!resultsCache[tf];
            const isActive = activeTimeframe === tf && !reversalMode;
            const isLoading = loading === tf;

            return (
              <button
                key={tf}
                disabled={loading !== null}
                onClick={() => {
                  setReversalMode(null);
                  handleAnalyze(tf);
                }}
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

          {/* 分隔线 */}
          <div className="w-px h-6 bg-[var(--border)] mx-1" />

          {/* 猜顶按钮 */}
          <button
            disabled={loading !== null}
            onClick={() => handleReversalAnalyze("top")}
            className={`px-3 py-1.5 rounded text-sm transition-colors relative ${
              loading === "reversal-top"
                ? "bg-red-500 text-white"
                : reversalMode === "top"
                ? "bg-red-500/20 text-red-400 border border-red-500/50"
                : reversalCache["top"]
                ? "bg-green-500/10 text-green-500 border border-green-500/30 hover:bg-green-500/20"
                : "bg-red-500/10 text-red-500 border border-red-500/30 hover:bg-red-500/20"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loading === "reversal-top" ? "推演中..." : "🔴 猜顶"}
            {reversalCache["top"] && reversalMode !== "top" && loading !== "reversal-top" && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full" />
            )}
          </button>

          {/* 猜底按钮 */}
          <button
            disabled={loading !== null}
            onClick={() => handleReversalAnalyze("bottom")}
            className={`px-3 py-1.5 rounded text-sm transition-colors relative ${
              loading === "reversal-bottom"
                ? "bg-green-500 text-white"
                : reversalMode === "bottom"
                ? "bg-green-500/20 text-green-400 border border-green-500/50"
                : reversalCache["bottom"]
                ? "bg-green-500/10 text-green-500 border border-green-500/30 hover:bg-green-500/20"
                : "bg-green-500/10 text-green-500 border border-green-500/30 hover:bg-green-500/20"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {loading === "reversal-bottom" ? "推演中..." : "🟢 猜底"}
            {reversalCache["bottom"] && reversalMode !== "bottom" && loading !== "reversal-bottom" && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full" />
            )}
          </button>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* 加载中 */}
        {loading && !currentResult && !reversalResult && (
          <div className="flex items-center justify-center py-8">
            <div className={`w-6 h-6 border-2 ${loading?.startsWith('reversal') ? (loading === 'reversal-top' ? 'border-red-500' : 'border-green-500') : 'border-blue-500'} border-t-transparent rounded-full animate-spin mr-3`}></div>
            <span className="text-[var(--text-tertiary)]">
              {loading?.startsWith('reversal') ? (loading === 'reversal-top' ? '猜顶推演中...' : '猜底推演中...') : '天机推演中...'}
            </span>
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
                  ${(currentResult.currentPrice ?? 0).toFixed(2)}
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
                      ${(currentResult.signal.entry?.price ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">渡劫线: </span>
                    <span className="font-medium text-red-500">
                      ${(currentResult.signal.stopLoss?.price ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">因果比: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      1:{(currentResult.signal.riskReward ?? 0).toFixed(1)}
                    </span>
                  </div>
                </div>
                {currentResult.signal.takeProfit && currentResult.signal.takeProfit.length > 0 && (
                  <div>
                    <span className="text-[var(--text-tertiary)] text-sm">
                      飞升境界:{" "}
                    </span>
                    {currentResult.signal.takeProfit.map((tp, i) => (
                      <span key={i} className="text-sm text-green-500 mr-2">
                        {i + 1}重天 ${(tp?.price ?? 0).toFixed(2)}
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
            {currentResult.signal.warnings && currentResult.signal.warnings.length > 0 && (
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

        {/* 反转分析结果 */}
        {reversalResult && (
          <div className="space-y-4">
            {/* 基本信息 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">模式</div>
                <div className={`text-lg font-semibold ${reversalResult.mode === 'top' ? 'text-red-500' : 'text-green-500'}`}>
                  {reversalResult.mode === 'top' ? '🔴 猜顶' : '🟢 猜底'}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">灵石价</div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  ${(reversalResult.currentPrice ?? 0).toFixed(2)}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">
                  {reversalResult.mode === 'top' ? '近期高点' : '近期低点'}
                </div>
                <div className={`text-lg font-semibold ${reversalResult.mode === 'top' ? 'text-red-400' : 'text-green-400'}`}>
                  ${reversalResult.mode === 'top'
                    ? (reversalResult.recentExtreme?.high ?? 0).toFixed(2)
                    : (reversalResult.recentExtreme?.low ?? 0).toFixed(2)}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">天意</div>
                <div className={`text-lg font-semibold ${reversalResult.signal ? getDirectionStyle(reversalResult.signal.direction) : 'text-[var(--text-tertiary)]'}`}>
                  {reversalResult.signal ? getDirectionText(reversalResult.signal.direction) : '静修 (观望)'}
                </div>
              </div>
            </div>

            {/* 有信号时显示详细交易计划 */}
            {reversalResult.signal && reversalResult.signal.direction !== 'neutral' && (
              <div className="p-4 bg-[var(--bg-tertiary)]/50 rounded-lg space-y-3">
                <h4 className="font-semibold text-[var(--text-primary)]">
                  {reversalResult.mode === 'top' ? '做空心法' : '做多心法'}
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-[var(--text-tertiary)]">道心: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      {getConfidenceText(reversalResult.signal.confidence)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">入道: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      ${(reversalResult.signal.entry?.price ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">渡劫线: </span>
                    <span className="font-medium text-red-500">
                      ${(reversalResult.signal.stopLoss?.price ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">因果比: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      1:{(reversalResult.signal.riskReward ?? 0).toFixed(1)}
                    </span>
                  </div>
                </div>
                {reversalResult.signal.takeProfit && reversalResult.signal.takeProfit.length > 0 && (
                  <div>
                    <span className="text-[var(--text-tertiary)] text-sm">飞升境界: </span>
                    {reversalResult.signal.takeProfit.map((tp, i) => (
                      <span key={i} className="text-sm text-green-500 mr-2">
                        {i + 1}重天 ${(tp?.price ?? 0).toFixed(2)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 无信号时显示基础入场点信息 */}
            {!reversalResult.signal && reversalResult.entry && (
              <div className="p-4 bg-[var(--bg-tertiary)]/50 rounded-lg space-y-3">
                <h4 className="font-semibold text-[var(--text-primary)]">
                  潜在入场区域
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                  <div>
                    <span className="text-[var(--text-tertiary)]">类型: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      {reversalResult.entry.type}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">建议入场: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      ${(reversalResult.entry.suggestedEntry ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">止损: </span>
                    <span className="font-medium text-red-500">
                      ${(reversalResult.entry.stopLoss ?? 0).toFixed(2)}
                    </span>
                  </div>
                </div>
                <div className="text-sm">
                  <span className="text-[var(--text-tertiary)]">入场区间: </span>
                  <span className="text-[var(--text-primary)]">
                    ${(reversalResult.entry.entryZone?.low ?? 0).toFixed(2)} - ${(reversalResult.entry.entryZone?.high ?? 0).toFixed(2)}
                  </span>
                </div>
              </div>
            )}

            {/* 无可用入场点 */}
            {!reversalResult.signal && !reversalResult.entry && (
              <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <p className="text-yellow-500 text-sm">
                  当前未发现符合条件的{reversalResult.mode === 'top' ? '做空' : '做多'}入场点。
                  {reversalResult.mode === 'top'
                    ? `价格需回撤至高点 $${(reversalResult.recentExtreme?.high ?? 0).toFixed(2)} 上方的 OB/FVG 区域。`
                    : `价格需回撤至低点 $${(reversalResult.recentExtreme?.low ?? 0).toFixed(2)} 下方的 OB/FVG 区域。`
                  }
                </p>
              </div>
            )}

            {/* 分析理由 */}
            {reversalResult.signal && (
              <div className="p-4 bg-[var(--bg-tertiary)]/50 rounded-lg">
                <h4 className="font-semibold text-[var(--text-primary)] mb-2">天道感悟</h4>
                <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
                  {reversalResult.signal.reasoning}
                </p>
              </div>
            )}

            {/* 风险警示 */}
            {reversalResult.signal && reversalResult.signal.warnings && reversalResult.signal.warnings.length > 0 && (
              <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <h4 className="font-semibold text-yellow-500 mb-2">劫难预警</h4>
                <ul className="text-sm text-yellow-500 space-y-1">
                  {reversalResult.signal.warnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 时间戳 */}
            <div className="text-xs text-[var(--text-tertiary)] text-right">
              推演时间: {new Date(reversalResult.timestamp).toLocaleString("zh-CN")}
            </div>
          </div>
        )}

        {/* 初始状态 */}
        {!currentResult && !reversalResult && !error && !loading && (
          <div className="text-center text-[var(--text-tertiary)] py-8">
            点击上方周期按钮开始天机推演
          </div>
        )}
      </div>
    </div>
  );
}
