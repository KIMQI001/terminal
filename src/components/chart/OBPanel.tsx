"use client";

import { useState, useMemo } from "react";
import { useIndicatorStore } from "@/stores/indicatorStore";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore, OTEPrefillData, TradingLine } from "@/stores/orderStore";
import { OrderBlock } from "@/types/indicator";

const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d', '1w'] as const;

export function OBPanel() {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { orderBlocks, multiTimeframeOB } = useIndicatorStore();
  const { candles } = useChartStore();
  const { setPrefillData, setTradingLines, openModal } = useOrderStore();

  const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;

  // 找到距离当前价格最近的OB周期
  const nearestTF = useMemo(() => {
    if (currentPrice === 0) return null;

    let minDistance = Infinity;
    let nearest: string | null = null;

    for (const tf of TIMEFRAMES) {
      const ob = multiTimeframeOB[tf];
      if (ob) {
        const mid = (ob.high + ob.low) / 2;
        const distance = Math.abs(mid - currentPrice);
        if (distance < minDistance) {
          minDistance = distance;
          nearest = tf;
        }
      }
    }

    return nearest;
  }, [multiTimeframeOB, currentPrice]);

  // 点击OB条目，填充交易参数
  const handleOBClick = (ob: OrderBlock) => {
    const isBullish = ob.type === "bullish";
    const side = isBullish ? "buy" : "sell";
    const entry = (ob.high + ob.low) / 2; // 入场点在OB中间
    const size = ob.high - ob.low;
    const stopLoss = isBullish ? ob.low : ob.high; // 止损在OB边界

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

  // 计算OB被填充的百分比
  const calculateFillPercent = (ob: OrderBlock): number => {
    if (currentPrice === 0) return 0;
    const isBullish = ob.type === "bullish";
    const size = ob.high - ob.low;
    if (size === 0) return 0;

    if (isBullish) {
      // 看涨OB: 价格从上方进入
      if (currentPrice >= ob.high) return 0;
      if (currentPrice <= ob.low) return 100;
      return ((ob.high - currentPrice) / size) * 100;
    } else {
      // 看跌OB: 价格从下方进入
      if (currentPrice <= ob.low) return 0;
      if (currentPrice >= ob.high) return 100;
      return ((currentPrice - ob.low) / size) * 100;
    }
  };

  return (
    <div className="bg-white/95 border border-gray-200 rounded-lg shadow-lg">
      {/* 标题栏 - 折叠按钮 */}
      <div
        className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg border-b border-gray-100"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <span className="text-xs font-semibold text-gray-600">OB</span>
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
                <span className="text-right">Mid</span>
                <span className="text-right">Size</span>
              </div>

              {TIMEFRAMES.map((tf) => {
                const ob = multiTimeframeOB[tf];
                const isNearest = tf === nearestTF;

                if (!ob) {
                  return (
                    <div key={tf} className="grid grid-cols-4 gap-1 text-[9px] py-0.5 items-center">
                      <span className="font-medium text-gray-600">{tf}</span>
                      <span className="text-gray-300">-</span>
                      <span className="text-right text-gray-300">-</span>
                      <span className="text-right text-gray-300">-</span>
                    </div>
                  );
                }

                const isBullish = ob.type === "bullish";
                const typeColor = isBullish ? "text-green-600" : "text-red-500";
                const typeLabel = isBullish ? "BUY" : "SELL";
                const obHeight = ob.high - ob.low;
                const midPrice = (ob.high + ob.low) / 2;
                const sizePercent = ((obHeight / midPrice) * 100).toFixed(2);

                // 计算填充百分比
                const fillPercent = calculateFillPercent(ob);

                // 虚线框颜色：看涨用绿色，看跌用红色
                const borderColor = isNearest ? (isBullish ? 'border-green-500' : 'border-red-500') : 'border-transparent';
                const fillColor = isBullish ? 'bg-green-200' : 'bg-red-200';

                return (
                  <div
                    key={tf}
                    onClick={() => handleOBClick(ob)}
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
                    <span className="relative text-right font-mono">{midPrice.toFixed(1)}</span>
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
            <div className="text-[10px] font-semibold text-gray-500 mb-1">Zones ({orderBlocks.length})</div>
            {orderBlocks.length === 0 ? (
              <div className="text-[9px] text-gray-400">No zones</div>
            ) : (
              <div className="space-y-1">
                {[...orderBlocks].sort((a, b) => b.startTime - a.startTime).map((ob, index) => {
                  const isBullish = ob.type === "bullish";
                  const color = isBullish ? "text-green-600" : "text-red-500";
                  const bgColor = isBullish ? "bg-green-50" : "bg-red-50";
                  const fillColor = isBullish ? "bg-green-200" : "bg-red-200";
                  const hoverColor = isBullish ? "hover:bg-green-100" : "hover:bg-red-100";
                  const label = isBullish ? "BUY" : "SELL";
                  const obHeight = ob.high - ob.low;
                  const midPrice = (ob.high + ob.low) / 2;
                  const sizePercent = ((obHeight / midPrice) * 100).toFixed(2);

                  // 计算填充百分比
                  const fillPercent = calculateFillPercent(ob);

                  return (
                    <div
                      key={index}
                      onClick={() => handleOBClick(ob)}
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
                        <span className="text-gray-500">M:{midPrice.toFixed(1)}</span>
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
