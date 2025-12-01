/**
 * Breaker Block Primitive for Lightweight Charts v4
 *
 * Draws Breaker Blocks - failed Order Blocks that become reverse support/resistance.
 * - Bullish Breaker (from failed bearish OB): Blue zone
 * - Bearish Breaker (from failed bullish OB): Orange zone
 * Uses crossed-out pattern to indicate it's a "broken" block
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
import { BreakerBlock } from '@/lib/chart/indicators/breakerBlocks';

interface BreakerRendererData {
  breakers: BreakerBlock[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class BreakerPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: BreakerRendererData | null = null;

  update(data: BreakerRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.breakers.length === 0) return;

    const { breakers, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const breaker of breakers) {
        const top = priceToCoordinate(breaker.high);
        const bottom = priceToCoordinate(breaker.low);
        const startX = timeToCoordinate(breaker.startTime as Time);

        if (top === null || bottom === null || startX === null) continue;

        let endX: number;
        if (breaker.endTime) {
          const endCoord = timeToCoordinate(breaker.endTime as Time);
          endX = endCoord !== null ? endCoord : chartWidth;
        } else {
          endX = chartWidth;
        }

        const height = Math.abs(bottom - top);
        const width = endX - startX;
        const y = Math.min(top, bottom);

        if (width <= 0 || height <= 0) continue;

        // Bullish breaker: Blue-cyan (supports price from below)
        // Bearish breaker: Orange (resists price from above)
        const isBullish = breaker.type === 'bullish';
        const baseColor = isBullish ? '59, 130, 246' : '249, 115, 22';
        const fillOpacity = breaker.mitigated ? 0.06 : 0.12;
        const borderOpacity = breaker.mitigated ? 0.3 : 0.6;

        // Fill rectangle
        ctx.fillStyle = `rgba(${baseColor}, ${fillOpacity})`;
        ctx.fillRect(startX, y, width, height);

        // Draw X pattern to indicate "broken" block
        ctx.strokeStyle = `rgba(${baseColor}, ${fillOpacity + 0.1})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);

        // Draw diagonal lines (X pattern)
        ctx.beginPath();
        ctx.moveTo(startX, y);
        ctx.lineTo(startX + Math.min(width, height), y + Math.min(width, height));
        ctx.moveTo(startX, y + height);
        ctx.lineTo(startX + Math.min(width, height), y + height - Math.min(width, height));
        ctx.stroke();

        // Draw border
        ctx.strokeStyle = `rgba(${baseColor}, ${borderOpacity})`;
        ctx.lineWidth = 1;

        if (breaker.mitigated) {
          ctx.setLineDash([4, 4]);
        } else {
          ctx.setLineDash([]);
        }

        ctx.strokeRect(startX, y, width, height);
        ctx.setLineDash([]);

        // Label
        ctx.font = 'bold 9px monospace';
        ctx.fillStyle = `rgba(${baseColor}, ${borderOpacity + 0.2})`;
        const label = isBullish ? 'BB+' : 'BB-';
        ctx.fillText(label, startX + 4, y + 12);
      }
    });
  }
}

class BreakerPaneView implements ISeriesPrimitivePaneView {
  private _renderer: BreakerPaneRenderer;
  private _data: BreakerRendererData | null = null;

  constructor() {
    this._renderer = new BreakerPaneRenderer();
  }

  update(data: BreakerRendererData): void {
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

export class BreakerBlockPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: BreakerPaneView;
  private _breakers: BreakerBlock[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new BreakerPaneView();
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

    const data: BreakerRendererData = {
      breakers: this._breakers,
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
   * Update Breaker Blocks data
   */
  setData(breakers: BreakerBlock[]): void {
    this._breakers = breakers;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Get current Breaker Blocks
   */
  getData(): BreakerBlock[] {
    return this._breakers;
  }
}
