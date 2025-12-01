/**
 * Order Block Primitive for Lightweight Charts v4
 *
 * Draws Order Blocks as semi-transparent rectangles on the chart.
 * - Bullish OB: Green background
 * - Bearish OB: Red background
 * - Mitigated OB: Dashed border
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
import { OrderBlock } from '@/types/indicator';

interface OrderBlockRendererData {
  orderBlocks: OrderBlock[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class OrderBlockPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: OrderBlockRendererData | null = null;

  update(data: OrderBlockRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.orderBlocks.length === 0) return;

    const { orderBlocks, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const ob of orderBlocks) {
        const top = priceToCoordinate(ob.high);
        const bottom = priceToCoordinate(ob.low);
        const startX = timeToCoordinate(ob.startTime as Time);

        if (top === null || bottom === null || startX === null) continue;

        // End time: either mitigated point or extend to chart edge
        let endX: number;
        if (ob.endTime) {
          const endCoord = timeToCoordinate(ob.endTime as Time);
          endX = endCoord !== null ? endCoord : chartWidth;
        } else {
          endX = chartWidth;
        }

        const height = Math.abs(bottom - top);
        const width = endX - startX;

        if (width <= 0 || height <= 0) continue;

        // Set colors based on OB type
        const isBullish = ob.type === 'bullish';
        const fillColor = isBullish ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)';
        const borderColor = isBullish ? 'rgba(34, 197, 94, 0.6)' : 'rgba(239, 68, 68, 0.6)';

        // Fill rectangle
        ctx.fillStyle = fillColor;
        ctx.fillRect(startX, Math.min(top, bottom), width, height);

        // Draw border
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;

        if (ob.mitigated) {
          // Dashed border for mitigated OB
          ctx.setLineDash([4, 4]);
        } else {
          ctx.setLineDash([]);
        }

        ctx.strokeRect(startX, Math.min(top, bottom), width, height);

        // Reset line dash
        ctx.setLineDash([]);
      }
    });
  }
}

class OrderBlockPaneView implements ISeriesPrimitivePaneView {
  private _renderer: OrderBlockPaneRenderer;
  private _data: OrderBlockRendererData | null = null;

  constructor() {
    this._renderer = new OrderBlockPaneRenderer();
  }

  update(data: OrderBlockRendererData): void {
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

export class OrderBlockPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: OrderBlockPaneView;
  private _orderBlocks: OrderBlock[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new OrderBlockPaneView();
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

    const data: OrderBlockRendererData = {
      orderBlocks: this._orderBlocks,
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
   * Update Order Blocks data
   */
  setData(orderBlocks: OrderBlock[]): void {
    this._orderBlocks = orderBlocks;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Get current Order Blocks
   */
  getData(): OrderBlock[] {
    return this._orderBlocks;
  }
}
