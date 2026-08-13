/**
 * Rejection Primitive for Lightweight Charts v4
 *
 * 绘制拒绝 K 线:
 * - Wick 区域:半透明矩形(看涨绿,看跌红),从该K线位置画到当前最新K线
 * - 中线射线:wick 区域中线水平实线,从K线位置延伸到图表右边缘
 *
 * 类比 OrderBlock:wick 区域相当于 OB 的 box;中线射线相当于 EQ 的中线
 */

import {
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesPrimitivePaneViewZOrder,
  Time,
  Coordinate,
  SeriesAttachedParameter,
} from 'lightweight-charts';
import type { IChartApiBase } from 'lightweight-charts';
import { CanvasRenderingTarget2D } from 'fancy-canvas';
import { Rejection } from '@/types/indicator';

interface RejectionRendererData {
  rejections: Rejection[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class RejectionPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: RejectionRendererData | null = null;

  update(data: RejectionRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.rejections.length === 0) return;

    const { rejections, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const r of rejections) {
        const yTop = priceToCoordinate(r.high);
        const yBottom = priceToCoordinate(r.low);
        const yMid = priceToCoordinate(r.mid);
        const startX = timeToCoordinate(r.time as Time);

        if (yTop === null || yBottom === null || yMid === null || startX === null) continue;

        const endX = chartWidth;
        const width = endX - startX;
        const height = Math.abs(yBottom - yTop);
        if (width <= 0 || height <= 0) continue;

        const isBullish = r.type === 'bullish';
        const fillColor = isBullish ? 'rgba(34, 197, 94, 0.18)' : 'rgba(239, 68, 68, 0.18)';
        const borderColor = isBullish ? 'rgba(34, 197, 94, 0.55)' : 'rgba(239, 68, 68, 0.55)';
        const lineColor = isBullish ? 'rgba(34, 197, 94, 0.85)' : 'rgba(239, 68, 68, 0.85)';

        // 1. wick 区域背景(矩形)
        ctx.fillStyle = fillColor;
        ctx.fillRect(startX, Math.min(yTop, yBottom), width, height);

        // 2. wick 区域边框
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(startX, Math.min(yTop, yBottom), width, height);

        // 3. 中线射线(从K线到chart右边缘的实线)
        ctx.beginPath();
        ctx.moveTo(startX, yMid);
        ctx.lineTo(endX, yMid);
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);  // 实线
        ctx.stroke();

        // 4. K 线左侧 "R" 标签(在 mid 高度)
        ctx.font = 'bold 10px monospace';
        ctx.fillStyle = isBullish ? 'rgba(34, 197, 94, 0.9)' : 'rgba(239, 68, 68, 0.9)';
        ctx.fillText('R', startX + 4, yMid + 3);
      }
    });
  }
}

class RejectionPaneView implements ISeriesPrimitivePaneView {
  private _renderer: RejectionPaneRenderer;
  private _data: RejectionRendererData | null = null;

  constructor() {
    this._renderer = new RejectionPaneRenderer();
  }

  update(data: RejectionRendererData): void {
    this._data = data;
    this._renderer.update(data);
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    return 'bottom';
  }
}

export class RejectionPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: RejectionPaneView;
  private _rejections: Rejection[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new RejectionPaneView();
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

    const data: RejectionRendererData = {
      rejections: this._rejections,
      priceToCoordinate: (price: number) => this._series!.priceToCoordinate(price),
      timeToCoordinate: (time: Time) => timeScale.timeToCoordinate(time),
      chartWidth: timeScale.width(),
    };

    this._paneView.update(data);
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  /**
   * Update Rejections data
   */
  setData(rejections: Rejection[]): void {
    this._rejections = rejections;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Get current Rejections
   */
  getData(): Rejection[] {
    return this._rejections;
  }
}
