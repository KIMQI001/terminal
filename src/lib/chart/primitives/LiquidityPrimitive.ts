/**
 * Liquidity Zone Primitive for Lightweight Charts v4
 *
 * Draws Liquidity Zones as horizontal dashed lines with "$$$" markers.
 * - Buy-side (equal lows): Red lines below current price
 * - Sell-side (equal highs): Green lines above current price
 * - Swept zones: More transparent
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
import { LiquidityZone } from '@/types/indicator';

interface LiquidityRendererData {
  zones: LiquidityZone[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class LiquidityPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: LiquidityRendererData | null = null;

  update(data: LiquidityRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.zones.length === 0) return;

    const { zones, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const zone of zones) {
        const y = priceToCoordinate(zone.level);
        if (y === null) continue;

        // Find the leftmost time for this zone
        const minTime = Math.min(...zone.times);
        const startX = timeToCoordinate(minTime as Time);
        if (startX === null) continue;

        const isBuySide = zone.type === 'buy-side';
        const baseOpacity = zone.swept ? 0.3 : 0.7;

        // Colors: buy-side (below) is red target, sell-side (above) is green target
        const color = isBuySide
          ? `rgba(239, 68, 68, ${baseOpacity})`
          : `rgba(34, 197, 94, ${baseOpacity})`;

        // Draw dashed horizontal line
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);

        ctx.beginPath();
        ctx.moveTo(startX, y);
        ctx.lineTo(chartWidth, y);
        ctx.stroke();

        ctx.setLineDash([]);

        // Draw "$" markers at touch points (strength indicator)
        const dollarMarkers = Math.min(zone.strength, 3); // Max 3 "$" symbols
        const markerText = '$'.repeat(dollarMarkers);

        ctx.font = 'bold 10px monospace';
        ctx.fillStyle = color;

        // Draw at the right edge
        const textWidth = ctx.measureText(markerText).width;
        const labelX = chartWidth - textWidth - 8;
        const labelY = y - 4;

        // Background for label
        ctx.fillStyle = isBuySide
          ? 'rgba(239, 68, 68, 0.15)'
          : 'rgba(34, 197, 94, 0.15)';
        ctx.fillRect(labelX - 4, labelY - 10, textWidth + 8, 14);

        // Label text
        ctx.fillStyle = color;
        ctx.fillText(markerText, labelX, labelY);

        // Draw small circles at each touch point
        for (const time of zone.times) {
          const x = timeToCoordinate(time as Time);
          if (x !== null) {
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
          }
        }
      }
    });
  }
}

class LiquidityPaneView implements ISeriesPrimitivePaneView {
  private _renderer: LiquidityPaneRenderer;
  private _data: LiquidityRendererData | null = null;

  constructor() {
    this._renderer = new LiquidityPaneRenderer();
  }

  update(data: LiquidityRendererData): void {
    this._data = data;
    this._renderer.update(data);
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    return 'top';
  }
}

export class LiquidityPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: LiquidityPaneView;
  private _zones: LiquidityZone[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new LiquidityPaneView();
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

    const data: LiquidityRendererData = {
      zones: this._zones,
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
   * Update Liquidity Zones data
   */
  setData(zones: LiquidityZone[]): void {
    this._zones = zones;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Get current Liquidity Zones
   */
  getData(): LiquidityZone[] {
    return this._zones;
  }
}
