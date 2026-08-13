/**
 * FVG (Fair Value Gap) Primitive for Lightweight Charts v4
 *
 * Draws Fair Value Gaps as semi-transparent rectangles with diagonal lines.
 * - Bullish FVG: Green with diagonal lines pattern
 * - Bearish FVG: Red with diagonal lines pattern
 * - Filled FVG: More transparent, shows fill percentage
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
import { FVG } from '@/types/indicator';

interface FVGRendererData {
  fvgs: FVG[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class FVGPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: FVGRendererData | null = null;

  update(data: FVGRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.fvgs.length === 0) return;

    const { fvgs, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const fvg of fvgs) {
        const top = priceToCoordinate(fvg.high);
        const bottom = priceToCoordinate(fvg.low);
        const startX = timeToCoordinate(fvg.time as Time);

        if (top === null || bottom === null || startX === null) continue;

        // FVG extends to chart edge (until fully filled)
        const endX = chartWidth;
        const height = Math.abs(bottom - top);
        const width = endX - startX;

        if (width <= 0 || height <= 0) continue;

        const isBullish = fvg.type === 'bullish';
        const y = Math.min(top, bottom);

        // Adjust opacity based on fill percentage
        const baseOpacity = fvg.filled ? 0.08 : 0.12;
        const fillColor = isBullish
          ? `rgba(34, 197, 94, ${baseOpacity})`
          : `rgba(239, 68, 68, ${baseOpacity})`;
        const lineColor = isBullish
          ? 'rgba(34, 197, 94, 0.4)'
          : 'rgba(239, 68, 68, 0.4)';

        // Draw filled background
        ctx.fillStyle = fillColor;
        ctx.fillRect(startX, y, width, height);

        // Draw diagonal lines pattern
        ctx.save();
        ctx.beginPath();
        ctx.rect(startX, y, width, height);
        ctx.clip();

        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1;

        const lineSpacing = 8;
        const totalDiagonal = width + height;

        for (let i = -height; i < totalDiagonal; i += lineSpacing) {
          ctx.beginPath();
          ctx.moveTo(startX + i, y + height);
          ctx.lineTo(startX + i + height, y);
          ctx.stroke();
        }

        ctx.restore();

        // If partially filled, show the filled portion with darker color
        if (fvg.fillPercentage > 0 && fvg.fillPercentage < 100) {
          const filledHeight = height * (fvg.fillPercentage / 100);
          const filledY = isBullish ? y : y + height - filledHeight;

          const filledColor = isBullish
            ? 'rgba(34, 197, 94, 0.25)'
            : 'rgba(239, 68, 68, 0.25)';

          ctx.fillStyle = filledColor;
          ctx.fillRect(startX, filledY, width, filledHeight);
        }

        // Draw border
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1;

        if (fvg.filled) {
          ctx.setLineDash([4, 4]);
        } else {
          ctx.setLineDash([]);
        }

        ctx.strokeRect(startX, y, width, height);
        ctx.setLineDash([]);

        // tier 标签(FVG 框中线 + 左侧靠 K 线):bullish → FS1, bearish → FR1
        const tierLabel = `${fvg.type === 'bullish' ? 'FS' : 'FR'}${fvg.tier}`;
        ctx.font = 'bold 9px monospace';
        ctx.fillStyle = lineColor;  // 跟边框同色
        const labelX = startX + 4;  // 左侧 4px(贴 K 线起点)
        const labelY = (Math.min(y, bottom) + Math.max(y, bottom)) / 2 + 3;
        ctx.fillText(tierLabel, labelX, labelY);
      }
    });
  }
}

class FVGPaneView implements ISeriesPrimitivePaneView {
  private _renderer: FVGPaneRenderer;
  private _data: FVGRendererData | null = null;

  constructor() {
    this._renderer = new FVGPaneRenderer();
  }

  update(data: FVGRendererData): void {
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

export class FVGPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: FVGPaneView;
  private _fvgs: FVG[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new FVGPaneView();
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

    const data: FVGRendererData = {
      fvgs: this._fvgs,
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
   * Update FVG data
   */
  setData(fvgs: FVG[]): void {
    this._fvgs = fvgs;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Get current FVGs
   */
  getData(): FVG[] {
    return this._fvgs;
  }
}
