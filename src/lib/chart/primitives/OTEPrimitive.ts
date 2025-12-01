/**
 * OTE (Optimal Trade Entry) Primitive for Lightweight Charts v4
 *
 * Draws Fibonacci retracement zones (0.618 - 0.786) for optimal trade entries.
 * - Bullish OTE: Green zone showing buy zone
 * - Bearish OTE: Red zone showing sell zone
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
import { OTEZone } from '@/lib/chart/indicators/ote';

interface OTERendererData {
  zones: OTEZone[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class OTEPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: OTERendererData | null = null;

  update(data: OTERendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.zones.length === 0) return;

    const { zones, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const zone of zones) {
        const y618 = priceToCoordinate(zone.fib618);
        const y786 = priceToCoordinate(zone.fib786);
        const y675 = priceToCoordinate(zone.fib675);
        const startX = timeToCoordinate(zone.startTime as Time);

        if (y618 === null || y786 === null || startX === null) continue;

        const isBullish = zone.type === 'bullish';
        const endX = chartWidth;
        const width = endX - startX;

        if (width <= 0) continue;

        // Calculate heights
        const top = Math.min(y618, y786);
        const bottom = Math.max(y618, y786);
        const height = bottom - top;

        // Base colors - 青色(买入) / 橙色(卖出)
        const baseColor = isBullish ? '6, 182, 212' : '249, 115, 22';
        const fillOpacity = zone.active ? 0.12 : 0.06;
        const borderOpacity = zone.active ? 0.5 : 0.25;

        // Fill the OTE zone (0.618 - 0.786)
        ctx.fillStyle = `rgba(${baseColor}, ${fillOpacity})`;
        ctx.fillRect(startX, top, width, height);

        // Draw borders at 0.618 and 0.786 levels
        ctx.strokeStyle = `rgba(${baseColor}, ${borderOpacity})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        // 0.618 line
        ctx.beginPath();
        ctx.moveTo(startX, y618);
        ctx.lineTo(endX, y618);
        ctx.stroke();

        // 0.786 line
        ctx.beginPath();
        ctx.moveTo(startX, y786);
        ctx.lineTo(endX, y786);
        ctx.stroke();

        ctx.setLineDash([]);

        // Draw sweet spot line at 0.675 (solid)
        if (y675 !== null) {
          ctx.strokeStyle = `rgba(${baseColor}, ${zone.active ? 0.7 : 0.35})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(startX, y675);
          ctx.lineTo(endX, y675);
          ctx.stroke();
        }

        // Labels
        ctx.font = '9px monospace';
        ctx.fillStyle = `rgba(${baseColor}, ${borderOpacity + 0.2})`;

        // 0.618 label
        ctx.fillText('0.618', endX - 35, y618 - 3);

        // 0.675 label (sweet spot)
        if (y675 !== null) {
          ctx.fillText('0.675', endX - 35, y675 - 3);
        }

        // 0.786 label
        ctx.fillText('0.786', endX - 35, y786 - 3);

        // OTE label at the zone start
        if (zone.active) {
          ctx.font = 'bold 10px monospace';
          ctx.fillStyle = `rgba(${baseColor}, 0.8)`;
          const label = isBullish ? 'OTE BUY' : 'OTE SELL';
          ctx.fillText(label, startX + 5, top + 12);
        }
      }
    });
  }
}

class OTEPaneView implements ISeriesPrimitivePaneView {
  private _renderer: OTEPaneRenderer;
  private _data: OTERendererData | null = null;

  constructor() {
    this._renderer = new OTEPaneRenderer();
  }

  update(data: OTERendererData): void {
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

export class OTEPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: OTEPaneView;
  private _zones: OTEZone[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new OTEPaneView();
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

    const data: OTERendererData = {
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
   * Update OTE Zones data
   */
  setData(zones: OTEZone[]): void {
    this._zones = zones;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Get current OTE Zones
   */
  getData(): OTEZone[] {
    return this._zones;
  }
}
