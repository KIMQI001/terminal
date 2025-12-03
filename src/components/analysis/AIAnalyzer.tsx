"use client";

import { useState } from "react";
import { triggerAnalyze, AnalyzeResult } from "@/lib/analysis/api";

const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d", "1w"];

export function AIAnalyzer() {
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async (timeframe: string) => {
    setLoading(timeframe);
    setError(null);
    setResult(null);

    try {
      const data = await triggerAnalyze("BTCUSDC", timeframe);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "分析失败");
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
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <h3 className="text-base font-medium text-[var(--text-primary)] flex items-center gap-2">
          <span>⚔️ 天机推演</span>
          <span className="text-xs font-normal text-[var(--text-tertiary)]">
            选择时间周期进行 AI 分析
          </span>
        </h3>
      </div>

      {/* Content */}
      <div className="p-4">
        {/* 时间周期按钮 */}
        <div className="flex flex-wrap gap-2 mb-4">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              disabled={loading !== null}
              onClick={() => handleAnalyze(tf)}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${
                loading === tf
                  ? "bg-blue-500 text-white"
                  : "bg-[var(--bg-tertiary)] hover:bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)]"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {loading === tf ? "推演中..." : tf.toUpperCase()}
            </button>
          ))}
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="p-3 mb-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* 分析结果 */}
        {result && (
          <div className="space-y-4">
            {/* 基本信息 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">周期</div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  {result.timeframe}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">灵石价</div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  ${result.currentPrice.toFixed(2)}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">天意</div>
                <div
                  className={`text-lg font-semibold ${getDirectionStyle(
                    result.signal.direction
                  )}`}
                >
                  {getDirectionText(result.signal.direction)}
                </div>
              </div>
              <div className="p-3 bg-[var(--bg-tertiary)] rounded-lg">
                <div className="text-xs text-[var(--text-tertiary)]">道心</div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  {getConfidenceText(result.signal.confidence)}
                </div>
              </div>
            </div>

            {/* 交易计划（非观望时显示） */}
            {result.signal.direction !== "neutral" && (
              <div className="p-4 bg-[var(--bg-tertiary)]/50 rounded-lg space-y-3">
                <h4 className="font-semibold text-[var(--text-primary)]">修炼心法</h4>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                  <div>
                    <span className="text-[var(--text-tertiary)]">入道: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      ${result.signal.entry.price.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">渡劫线: </span>
                    <span className="font-medium text-red-500">
                      ${result.signal.stopLoss.price.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)]">因果比: </span>
                    <span className="font-medium text-[var(--text-primary)]">
                      1:{result.signal.riskReward.toFixed(1)}
                    </span>
                  </div>
                </div>
                {result.signal.takeProfit.length > 0 && (
                  <div>
                    <span className="text-[var(--text-tertiary)] text-sm">
                      飞升境界:{" "}
                    </span>
                    {result.signal.takeProfit.map((tp, i) => (
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
                {result.signal.reasoning}
              </p>
            </div>

            {/* 风险警示 */}
            {result.signal.warnings.length > 0 && (
              <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <h4 className="font-semibold text-yellow-500 mb-2">劫难预警</h4>
                <ul className="text-sm text-yellow-500 space-y-1">
                  {result.signal.warnings.map((w, i) => (
                    <li key={i}>• {w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 时间戳 */}
            <div className="text-xs text-[var(--text-tertiary)] text-right">
              推演时间: {new Date(result.timestamp).toLocaleString("zh-CN")}
            </div>
          </div>
        )}

        {/* 初始状态 */}
        {!result && !error && !loading && (
          <div className="text-center text-[var(--text-tertiary)] py-8">
            点击上方周期按钮开始天机推演
          </div>
        )}
      </div>
    </div>
  );
}
