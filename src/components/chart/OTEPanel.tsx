"use client";

import { useState, useMemo } from "react";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore, OTEPrefillData, TradingLine } from "@/stores/orderStore";
import { OTEZone } from "@/lib/chart/indicators/ote";

const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d', '1w'] as const;

export function OTEPanel() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { oteZones, multiTimeframeOTE } = useIndicatorStore();
  const { candles } = useChartStore();
  const { setPrefillData, setTradingLines, openModal } = useOrderStore();

  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;

  // 找到距离当前价格最近的OTE周期
  const nearestTF = useMemo(() => {
    if (currentPrice === 0) return null;

    let minDistance = Infinity;
    let nearest: string | null = null;

    for (const tf of TIMEFRAMES) {
      const ote = multiTimeframeOTE[tf];
      if (ote) {
        const distance = Math.abs(ote.fib675 - currentPrice);
        if (distance < minDistance) {
          minDistance = distance;
          nearest = tf;
        }
      }
    }

    return nearest;
  }, [multiTimeframeOTE, currentPrice]);

  // 点击OTE条目，填充交易参数
  const handleOTEClick = (ote: OTEZone) => {
    const isBullish = ote.type === "bullish";
    const side = isBullish ? "buy" : "sell";
    const entry = ote.fib675;
    const stopLoss = ote.fib786;
    const size = Math.abs(ote.fib786 - ote.fib618);

    // 止盈 = size的5倍
    const takeProfit = isBullish
      ? entry + size * 5  // 看涨: 向上5倍
      : entry - size * 5; // 看跌: 向下5倍

    const prefillData: OTEPrefillData = {
      side,
      entry,
      stopLoss,
      takeProfit,
    };

    // 设置图表上的水平线
    const lines: TradingLine[] = [
      { price: entry, type: "entry", side },
      { price: stopLoss, type: "stopLoss", side },
      { price: takeProfit, type: "takeProfit", side },
    ];
    setTradingLines(lines);

    setPrefillData(prefillData);
    openModal();
  };

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg">
      {/* 标题栏 - 折叠按钮 */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="text-xs font-semibold text-gray-600">OTE</span>
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
                <span className="text-right">.675</span>
                <span className="text-right">Size</span>
              </div>

              {TIMEFRAMES.map((tf) => {
                const ote = multiTimeframeOTE[tf];
                const isNearest = tf === nearestTF;

                if (!ote) {
                  return (
                    <div key={tf} className="grid grid-cols-4 gap-1 text-[9px] py-0.5 items-center">
                      <span className="font-medium text-gray-600">{tf}</span>
                      <span className="text-gray-300">-</span>
                      <span className="text-right text-gray-300">-</span>
                      <span className="text-right text-gray-300">-</span>
                    </div>
                  );
                }

                const isBullish = ote.type === "bullish";
                const typeColor = isBullish ? "text-cyan-600" : "text-orange-500";
                const typeLabel = isBullish ? "BUY" : "SELL";
                const zoneHeight = Math.abs(ote.fib786 - ote.fib618);
                const midPrice = (ote.fib786 + ote.fib618) / 2;
                const sizePercent = ((zoneHeight / midPrice) * 100).toFixed(1);

                let fillPercent = 0;
                if (isBullish) {
                  if (currentPrice >= ote.fib618) fillPercent = 0;
                  else if (currentPrice <= ote.fib786) fillPercent = 100;
                  else fillPercent = ((ote.fib618 - currentPrice) / zoneHeight) * 100;
                } else {
                  if (currentPrice <= ote.fib618) fillPercent = 0;
                  else if (currentPrice >= ote.fib786) fillPercent = 100;
                  else fillPercent = ((currentPrice - ote.fib618) / zoneHeight) * 100;
                }

                // 虚线框颜色：看涨用蓝色，看跌用紫色
                const borderColor = isNearest ? (isBullish ? 'border-blue-500' : 'border-purple-500') : 'border-transparent';
                const fillColor = isBullish ? 'bg-blue-200' : 'bg-purple-200';

                return (
                  <div
                    key={tf}
                    onClick={() => handleOTEClick(ote)}
                    className={`relative grid grid-cols-4 gap-1 text-[9px] py-0.5 items-center rounded border border-dashed ${borderColor} overflow-hidden cursor-pointer hover:bg-gray-100 transition-colors`}
                  >
                    {/* 填充背景 - 从左到右填充 */}
                    {isNearest && fillPercent > 0 && (
                      <div
                        className={`absolute inset-y-0 left-0 ${fillColor} opacity-50`}
                        style={{ width: `${Math.min(100, Math.max(0, fillPercent))}%` }}
                      />
                    )}
                    {/* 内容 */}
                    <span className="relative font-medium text-gray-600">{tf}</span>
                    <span className={`relative font-semibold ${typeColor}`}>{typeLabel}</span>
                    <span className="relative text-right font-mono">{ote.fib675.toFixed(1)}</span>
                    <span className="relative text-right font-mono">{sizePercent}%</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 分隔线 */}
          <div className="w-px bg-gray-200 my-2" />

          {/* 右侧: Zones */}
          <div className="px-2 py-2 min-w-[130px] max-h-[180px] overflow-y-auto">
            <div className="text-[10px] font-semibold text-gray-500 mb-1">Zones ({oteZones.length})</div>
            {oteZones.length === 0 ? (
              <div className="text-[9px] text-gray-400">No zones</div>
            ) : (
              <div className="space-y-1">
                {oteZones.map((zone, index) => {
                  const isBullish = zone.type === "bullish";
                  const color = isBullish ? "text-cyan-600" : "text-orange-500";
                  const bgColor = isBullish ? "bg-cyan-50" : "bg-orange-50";
                  const hoverColor = isBullish ? "hover:bg-cyan-100" : "hover:bg-orange-100";
                  const label = isBullish ? "BUY" : "SELL";
                  const zoneHeight = Math.abs(zone.fib786 - zone.fib618);
                  const midPrice = (zone.fib786 + zone.fib618) / 2;
                  const sizePercent = ((zoneHeight / midPrice) * 100).toFixed(1);

                  let fillPercent = 0;
                  if (isBullish) {
                    if (currentPrice >= zone.fib618) fillPercent = 0;
                    else if (currentPrice <= zone.fib786) fillPercent = 100;
                    else fillPercent = ((zone.fib618 - currentPrice) / zoneHeight) * 100;
                  } else {
                    if (currentPrice <= zone.fib618) fillPercent = 0;
                    else if (currentPrice >= zone.fib786) fillPercent = 100;
                    else fillPercent = ((currentPrice - zone.fib618) / zoneHeight) * 100;
                  }

                  return (
                    <div
                      key={index}
                      onClick={() => handleOTEClick(zone)}
                      className={`${bgColor} ${hoverColor} rounded p-1 text-[9px] cursor-pointer transition-colors`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`font-bold ${color}`}>{label}</span>
                        <span className="text-gray-500">.675:{zone.fib675.toFixed(1)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-0.5">
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
