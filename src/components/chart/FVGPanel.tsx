"use client";

import { useState, useMemo, useEffect } from "react";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore, OTEPrefillData, TradingLine } from "@/stores/orderStore";
import { FVG } from "@/types/indicator";
// (overlap helpers 暂时未使用，保留供未来使用)

const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'] as const;

export function FVGPanel() {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const { fvgs, multiTimeframeFVG, multiTimeframeOB, multiTimeframeOTE } = useIndicatorStore();
  const { candles, timeframe } = useChartStore();
  const { setPrefillData, setTradingLines, openModal } = useOrderStore();

  // 获取指定周期的 FVG（当前周期优先使用 fvgs 数组，保证数据最新）
  const getFVGForTimeframe = (tf: string): FVG | null => {
    if (tf === timeframe && fvgs.length > 0) {
      // 当前周期：从 fvgs 数组取最新的（按时间降序）
      const sorted = [...fvgs].sort((a, b) => b.time - a.time);
      return sorted[0];
    }
    // 其他周期：从 multiTimeframeFVG 取
    return multiTimeframeFVG[tf as keyof typeof multiTimeframeFVG] || null;
  };

  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;

  // 找到距离当前价格最近的FVG周期
  const nearestTF = useMemo(() => {
    if (currentPrice === 0) return null;

    let minDistance = Infinity;
    let nearest: string | null = null;

    for (const tf of TIMEFRAMES) {
      // 内联 getFVGForTimeframe 逻辑
      let fvg: FVG | null = null;
      if (tf === timeframe && fvgs.length > 0) {
        const sorted = [...fvgs].sort((a, b) => b.time - a.time);
        fvg = sorted[0];
      } else {
        fvg = multiTimeframeFVG[tf] || null;
      }

      if (fvg) {
        const distance = Math.abs(fvg.fib22 - currentPrice);
        if (distance < minDistance) {
          minDistance = distance;
          nearest = tf;
        }
      }
    }

    return nearest;
  }, [multiTimeframeFVG, fvgs, timeframe, currentPrice]);

// FVG 入场比例三档循环：0.22（深）→ 0.60（中）→ 0.90（浅）→ 0.22
const FVG_RATIOS = [0.22, 0.60, 0.90];

  // 点击循环计数：第 1 次 → 0.22，第 2 次 → 0.60，第 3 次 → 0.90，再点回到 0.22
  const [fvgClickCount, setFvgClickCount] = useState(0);
  // fvgs 数量变化时重置（跟 OTE 一致）
  useEffect(() => {
    setFvgClickCount(0);
  }, [fvgs.length]);

  // 点击FVG条目，填充交易参数
  // 点击循环：0.22（深）→ 0.60（中）→ 0.90（浅）→ 0.22
  const handleFVGClick = (fvg: FVG) => {
    const isBullish = fvg.type === "bullish";
    const side = isBullish ? "buy" : "sell";
    const size = fvg.high - fvg.low;
    const ratio = FVG_RATIOS[fvgClickCount % 3];
    const rawEntry = isBullish
      ? fvg.high - size * ratio
      : fvg.low + size * ratio;
    const entry = isBullish
      ? Math.ceil(rawEntry / 5) * 5
      : Math.floor(rawEntry / 5) * 5;
    const stopLoss = isBullish ? fvg.low : fvg.high;
    const takeProfit = isBullish
      ? entry + size * 5
      : entry - size * 5;

    const prefillData: OTEPrefillData = {
      side,
      entry,
      stopLoss,
      takeProfit,
    };

    const lines: TradingLine[] = [
      { price: entry, type: "entry", side },
      { price: stopLoss, type: "stopLoss", side },
      { price: takeProfit, type: "takeProfit", side },
    ];
    setTradingLines(lines);

    setPrefillData(prefillData);
    openModal();
    setFvgClickCount(fvgClickCount + 1);
  };

  // 计算FVG被填充的百分比（用当前价格，作为 fallback）
  const calculateFillPercent = (fvg: FVG): number => {
    if (currentPrice === 0) return 0;
    const isBullish = fvg.type === "bullish";
    const size = fvg.high - fvg.low;
    if (size === 0) return 0;

    if (isBullish) {
      // 看涨FVG: 价格从上方进入
      if (currentPrice >= fvg.high) return 0;
      if (currentPrice <= fvg.low) return 100;
      return ((fvg.high - currentPrice) / size) * 100;
    } else {
      // 看跌FVG: 价格从下方进入
      if (currentPrice <= fvg.low) return 0;
      if (currentPrice >= fvg.high) return 100;
      return ((currentPrice - fvg.low) / size) * 100;
    }
  };

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg">
      {/* 标题栏 - 折叠按钮 */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="text-xs font-semibold text-gray-600">FVG</span>
        <span className="text-gray-400 text-[10px]">{isCollapsed ? '▶' : '▼'}</span>
      </div>

      {/* 内容区 - 左右两栏 */}
      {!isCollapsed && (
        <div className="flex">
          {/* 左侧: Multi-TF */}
          <div className="px-2 py-2 w-[200px]">
            <div className="text-[10px] font-semibold text-gray-500 mb-1">Multi-TF (点击开单)</div>
            <div className="space-y-0.5">
              <div className="grid grid-cols-4 gap-1 text-[9px] text-gray-400 font-medium pb-0.5 border-b">
                <span>TF</span>
                <span>Type</span>
                <span className="text-right">.22</span>
                <span className="text-right">Size</span>
              </div>

              {TIMEFRAMES.map((tf) => {
                const fvg = getFVGForTimeframe(tf);
                const isNearest = tf === nearestTF;

                if (!fvg) {
                  return (
                    <div key={tf} className="grid grid-cols-4 gap-1 text-[9px] py-0.5 items-center">
                      <span className="font-medium text-gray-600">{tf}</span>
                      <span className="text-gray-300">-</span>
                      <span className="text-right text-gray-300">-</span>
                      <span className="text-right text-gray-300">-</span>
                    </div>
                  );
                }

                const isBullish = fvg.type === "bullish";
                const typeColor = isBullish ? "text-green-600" : "text-red-500";
                const typeLabel = isBullish ? "BUY" : "SELL";
                const gapHeight = fvg.high - fvg.low;
                const midPrice = (fvg.high + fvg.low) / 2;
                const sizePercent = ((gapHeight / midPrice) * 100).toFixed(2);

                // 计算填充百分比（用当前价格作为 fallback）
                const fillPercent = calculateFillPercent(fvg);

                // 虚线框颜色：看涨用绿色，看跌用红色
                const borderColor = isNearest ? (isBullish ? 'border-green-500' : 'border-red-500') : 'border-transparent';
                const fillColor = isBullish ? 'bg-green-200' : 'bg-red-200';

                // 优先使用数据中的 fillPercentage（历史极值），如果是0或未定义则用当前价格计算
                const displayFillPercent = (fvg.fillPercentage && fvg.fillPercentage > 0) ? fvg.fillPercentage : fillPercent;

                return (
                  <div
                    key={tf}
                    onClick={() => handleFVGClick(fvg)}
                    className={`relative grid grid-cols-4 gap-1 text-[9px] py-0.5 items-center rounded border border-dashed ${borderColor} overflow-hidden cursor-pointer hover:bg-gray-100 transition-colors`}
                  >
                    {/* 填充背景 */}
                    {displayFillPercent > 0 && (
                      <div
                        className={`absolute inset-y-0 left-0 ${fillColor} opacity-50`}
                        style={{ width: `${Math.min(100, Math.max(0, displayFillPercent))}%` }}
                      />
                    )}
                    {/* 内容 */}
                    <span className="relative font-medium text-gray-600">{tf}</span>
                    <span className={`relative font-semibold ${typeColor}`}>{typeLabel}</span>
                    <span className="relative text-right font-mono">{fvg.fib22.toFixed(1)}</span>
                    <span className="relative text-right font-mono">{sizePercent}%</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 分隔线 */}
          <div className="w-px bg-gray-200 my-2" />

          {/* 右侧: Zones */}
          <div className="px-2 py-2 min-w-[130px] max-h-[140px] overflow-y-auto">
            <div className="text-[10px] font-semibold text-gray-500 mb-1">Zones ({fvgs.length})</div>
            {fvgs.length === 0 ? (
              <div className="text-[9px] text-gray-400">No zones</div>
            ) : (
              <div className="space-y-1">
                {[...fvgs].sort((a, b) => b.time - a.time).map((fvg, index) => {
                  const isBullish = fvg.type === "bullish";
                  const color = isBullish ? "text-green-600" : "text-red-500";
                  const bgColor = isBullish ? "bg-green-50" : "bg-red-50";
                  const fillColor = isBullish ? "bg-green-200" : "bg-red-200";
                  const hoverColor = isBullish ? "hover:bg-green-100" : "hover:bg-red-100";
                  const label = isBullish ? "BUY" : "SELL";
                  const gapHeight = fvg.high - fvg.low;
                  const midPrice = (fvg.high + fvg.low) / 2;
                  const sizePercent = ((gapHeight / midPrice) * 100).toFixed(2);

                  // 使用历史填充百分比
                  const fillPercent = fvg.fillPercentage;

                  return (
                    <div
                      key={index}
                      onClick={() => handleFVGClick(fvg)}
                      className={`relative ${hoverColor} rounded p-1 text-[9px] cursor-pointer transition-colors overflow-hidden`}
                    >
                      {/* 底色 */}
                      <div className={`absolute inset-0 ${bgColor}`} />
                      {/* 填充进度背景 */}
                      {fillPercent > 0 && (
                        <div
                          className={`absolute inset-y-0 left-0 ${fillColor} opacity-60`}
                          style={{ width: `${Math.min(100, fillPercent)}%` }}
                        />
                      )}
                      {/* 内容 */}
                      <div className="relative flex items-center justify-between">
                        <span className={`font-bold ${color}`}>{label}</span>
                        <span className="text-gray-500">.22:{fvg.fib22.toFixed(1)}</span>
                      </div>
                      <div className="relative flex items-center justify-between mt-0.5">
                        <span className="text-gray-500">S:{sizePercent}%</span>
                        <span className="text-gray-500">F:{fillPercent.toFixed(0)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
