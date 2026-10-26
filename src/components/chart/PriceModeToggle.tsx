"use client";

import { useChartStore } from "@/stores/chartStore";
import { cn } from "@/lib/utils";

/**
 * 顶部价格 + K 线显示模式按钮(S / L)
 *
 * 三态:
 *  - 白色(闲置):显示全部 K 线
 *  - 红色 S(做空):只显示「现价以上」的阳线
 *  - 绿色 L(做多):只显示「现价以下」的阴线
 *  再点一次当前模式 → 回到白色(恢复全部 K 线)
 */
export function PriceModeToggle() {
  const candles = useChartStore((s) => s.candles);
  const displayMode = useChartStore((s) => s.displayMode);
  const displayAnchorPrice = useChartStore((s) => s.displayAnchorPrice);
  const setDisplayMode = useChartStore((s) => s.setDisplayMode);

  const last = candles.length > 0 ? candles[candles.length - 1] : null;
  const price = last?.close ?? 0;
  const isUp = last ? last.close >= last.open : true;

  const handle = (mode: "short" | "long") => {
    setDisplayMode(displayMode === mode ? "normal" : mode);
  };

  const anchorText =
    displayAnchorPrice !== null
      ? `锚点现价 ${displayAnchorPrice.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      : "现价";

  const btn =
    "h-6 w-6 rounded border text-[11px] font-bold leading-none transition-colors";
  // 闲置态:白色;S 激活:红色;L 激活:绿色
  const idleBtn = "border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]";

  return (
    <div className="flex items-center gap-2 pl-1">
      {/* 当前价 */}
      <span
        className={cn(
          "font-mono text-xs tabular-nums",
          isUp ? "text-[var(--positive)]" : "text-[var(--negative)]"
        )}
      >
        {price > 0
          ? price.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })
          : "--"}
      </span>

      {/* S / L 切换 */}
      <div className="flex items-center gap-0.5 rounded border border-[var(--border)] p-0.5">
        <button
          type="button"
          onClick={() => handle("short")}
          title={
            displayMode === "short"
              ? `做空模式:只显示${anchorText}以上的阳线(再点一次恢复全部)`
              : `做空模式:只显示${anchorText}以上的阳线`
          }
          className={cn(
            btn,
            displayMode === "short"
              ? "border-[var(--negative)] bg-[var(--negative)] text-white"
              : idleBtn
          )}
        >
          S
        </button>
        <button
          type="button"
          onClick={() => handle("long")}
          title={
            displayMode === "long"
              ? `做多模式:只显示${anchorText}以下的阴线(再点一次恢复全部)`
              : `做多模式:只显示${anchorText}以下的阴线`
          }
          className={cn(
            btn,
            displayMode === "long"
              ? "border-[var(--positive)] bg-[var(--positive)] text-white"
              : idleBtn
          )}
        >
          L
        </button>
      </div>
    </div>
  );
}
