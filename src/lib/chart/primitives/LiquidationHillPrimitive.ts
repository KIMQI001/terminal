/**
 * Liquidation Hill Primitive for Lightweight Charts v4
 *
 * Draws horizontal liquidation bars on the price axis.
 * - Above current price: Orange bars (short liquidation zones)
 * - Below current price: Blue bars (long liquidation zones)
 * - Bar width proportional to liquidation amount
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

export interface LiquidationBar {
  price: number;
  amount: number;
  side: 'long' | 'short';
}

export interface LiquidationHillData {
  levels: LiquidationBar[];
  currentPrice: number;
}

interface LiquidationHillRendererData {
  levels: LiquidationBar[];
  currentPrice: number;
  priceToCoordinate: (price: number) => Coordinate | null;
  maxAmount: number;
}

/**
 * Hex color to RGBA
 */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

class LiquidationHillPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: LiquidationHillRendererData | null = null;

  update(data: LiquidationHillRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.levels.length === 0) return;

    const { levels, currentPrice, priceToCoordinate, maxAmount } = this._data;

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio, verticalPixelRatio }) => {
      for (const level of levels) {
        this._drawBar(ctx, level, currentPrice, priceToCoordinate, maxAmount, horizontalPixelRatio, verticalPixelRatio);
      }
    });
  }

  private _drawBar(
    ctx: CanvasRenderingContext2D,
    level: LiquidationBar,
    currentPrice: number,
    priceToCoordinate: (price: number) => Coordinate | null,
    maxAmount: number,
    hPixelRatio: number,
    vPixelRatio: number
  ): void {
    const { price, amount } = level;

    const priceY = priceToCoordinate(price);
    if (priceY === null) return;

    // Convert to bitmap coordinates
    const y = priceY * vPixelRatio;

    // Calculate width based on amount ratio (max 200px)
    const maxWidth = 200;
    const width = (amount / maxAmount) * maxWidth * hPixelRatio;

    // Start from left edge
    const startX = 0;

    // Bar height (fixed at 6px)
    const barHeight = 6 * vPixelRatio;

    // Center bar on price line
    const barY = y - barHeight / 2;

    // Color based on position relative to current price
    // Above current price = orange (short liquidation zones)
    // Below current price = blue (long liquidation zones)
    const isAbove = price > currentPrice;
    const baseColor = isAbove ? '#FFB347' : '#87CEEB'; // Orange : Light blue
    const alpha = 0.4;

    // Create gradient (darker in center, lighter at edges)
    const gradient = ctx.createLinearGradient(startX, barY, startX + width, barY);
    gradient.addColorStop(0, hexToRgba(baseColor, alpha * 0.6));
    gradient.addColorStop(0.5, hexToRgba(baseColor, alpha));
    gradient.addColorStop(1, hexToRgba(baseColor, alpha * 0.6));

    // Draw filled bar
    ctx.fillStyle = gradient;
    ctx.fillRect(startX, barY, width, barHeight);

    // Draw border
    ctx.strokeStyle = hexToRgba(baseColor, alpha * 1.2);
    ctx.lineWidth = 1 * hPixelRatio;
    ctx.strokeRect(startX, barY, width, barHeight);
  }
}

class LiquidationHillPaneView implements ISeriesPrimitivePaneView {
  private _renderer: LiquidationHillPaneRenderer;
  private _data: LiquidationHillRendererData | null = null;

  constructor() {
    this._renderer = new LiquidationHillPaneRenderer();
  }

  update(data: LiquidationHillRendererData): void {
    this._data = data;
    this._renderer.update(data);
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    return 'top'; // Draw on top of candles
  }
}

export class LiquidationHillPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: LiquidationHillPaneView;
  private _data: LiquidationHillData | null = null;
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new LiquidationHillPaneView();
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
    if (!this._chart || !this._series || !this._data) return;

    const maxAmount = this._data.levels.length > 0
      ? Math.max(...this._data.levels.map(l => l.amount))
      : 1;

    const rendererData: LiquidationHillRendererData = {
      levels: this._data.levels,
      currentPrice: this._data.currentPrice,
      priceToCoordinate: (price: number) => this._series!.priceToCoordinate(price),
      maxAmount,
    };

    this._paneView.update(rendererData);
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  /**
   * Update liquidation data
   */
  setData(data: LiquidationHillData | null): void {
    this._data = data;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Get current liquidation data
   */
  getData(): LiquidationHillData | null {
    return this._data;
  }
}
