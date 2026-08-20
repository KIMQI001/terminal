// src/lib/chart/primitives/FibLevelPrimitive.ts
//
// 在图上画 FVG/OB 的三档 fib 水平虚线(22/50/90 价位)
// - 看涨 FVG:high - size*22%/50%/90%
// - 看跌 FVG:low + size*22%/50%/90%
// - 看涨 OB:同上(从 high 往下走)
// - 看跌 OB:同上(从 low 往上走)

import {
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesPrimitivePaneViewZOrder,
  Time,
  Coordinate,
  SeriesAttachedParameter,
} from "lightweight-charts";
import type { IChartApiBase } from "lightweight-charts";
import { CanvasRenderingTarget2D } from "fancy-canvas";

export interface FibLevel {
  /** 起点(zone 起始 K) */
  time: number;
  high: number;
  low: number;
  type: "fvg" | "ob";
  side: "bullish" | "bearish";
  fib22: number;
  fib50: number;
  fib90: number;
}

interface FibRendererData {
  items: FibLevel[];
  activeRatio: 0 | 1 | 2;
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class FibPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: FibRendererData | null = null;

  update(data: FibRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.items.length === 0) return;

    const { items, activeRatio, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const item of items) {
        const startX = timeToCoordinate(item.time as Time);
        if (startX === null) continue;

        const isBullish = item.side === "bullish";
        // 看涨用紫,看跌用橙
        const color = isBullish ? "rgba(168, 85, 247, 0.7)" : "rgba(251, 146, 60, 0.7)";

        // 只画当前 activeRatio 对应的那条水平线
        // 跟 OBPanel 的 OB_RATIOS = [0.22, 0.60, 0.90] + 取整到 5 完全一致
        const rawValue = activeRatio === 0 ? item.fib22
          : activeRatio === 1 ? item.fib50
          : item.fib90;
        // 取整到 5(看涨向上 ceil,看跌向下 floor)— 跟 OBPanel 一致
        const value = isBullish
          ? Math.ceil(rawValue / 5) * 5
          : Math.floor(rawValue / 5) * 5;
        const label = activeRatio === 0 ? ".22"
          : activeRatio === 1 ? ".60"
          : ".90";

        const y = priceToCoordinate(value);
        if (y === null) continue;

        // 虚线水平线
        ctx.beginPath();
        ctx.moveTo(startX, y);
        ctx.lineTo(chartWidth, y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // 右侧标签
        ctx.font = "9px monospace";
        const textWidth = ctx.measureText(label).width;
        const labelX = chartWidth - textWidth - 6;
        const labelY = y - 3;
        ctx.fillStyle = isBullish
          ? "rgba(168, 85, 247, 0.18)"
          : "rgba(251, 146, 60, 0.18)";
        ctx.fillRect(labelX - 3, labelY - 9, textWidth + 6, 14);
        ctx.fillStyle = color;
        ctx.fillText(label, labelX, labelY);
      }
    });
  }
}

class FibPaneView implements ISeriesPrimitivePaneView {
  private _renderer: FibPaneRenderer;
  private _data: FibRendererData | null = null;

  constructor() {
    this._renderer = new FibPaneRenderer();
  }

  update(data: FibRendererData): void {
    this._data = data;
    this._renderer.update(data);
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    return "bottom";
  }
}

export class FibLevelPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: FibPaneView;
  private _items: FibLevel[] = [];
  /** 0=0.22, 1=0.5, 2=0.9 — 只画当前 ratio 对应的那条 */
  private _activeRatio: 0 | 1 | 2 = 0;
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>["series"] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new FibPaneView();
  }

  attached(params: SeriesAttachedParameter<Time>): void {
    this._chart = params.chart;
    this._series = params.series;
    this._requestUpdate = params.requestUpdate;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = undefined;
  }

  updateAllViews(): void {
    if (!this._chart || !this._series) return;

    const timeScale = this._chart.timeScale();

    const data: FibRendererData = {
      items: this._items,
      activeRatio: this._activeRatio,
      priceToCoordinate: (price: number) => this._series!.priceToCoordinate(price),
      timeToCoordinate: (time: Time) => timeScale.timeToCoordinate(time),
      chartWidth: timeScale.width(),
    };

    this._paneView.update(data);
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  setData(items: FibLevel[], activeRatio: 0 | 1 | 2 = 0): void {
    this._items = items;
    this._activeRatio = activeRatio;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  getData(): FibLevel[] {
    return this._items;
  }
}
