/**
 * Equilibrium Primitive for Lightweight Charts v4
 *
 * Draws Premium/Discount zones and the 50% equilibrium line.
 * - Premium (above EQ): light red background — sell-side bias zone
 * - Discount (below EQ): light green background — buy-side bias zone
 * - EQ middle line: gold dashed with price label
 *
 * - pairIndex 0: primary (current TF, full opacity)
 * - pairIndex 1: secondary reference (more transparent)
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
import { EquilibriumLevel } from '@/lib/chart/indicators/equilibrium';

interface EquilibriumRendererData {
  zones: EquilibriumLevel[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class EquilibriumPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: EquilibriumRendererData | null = null;

  update(data: EquilibriumRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.zones.length === 0) return;

    const { zones, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const zone of zones) {
        // 过滤掉被反向穿越的 range
        if (!zone.valid) continue;

        const yEq = priceToCoordinate(zone.equilibrium);
        const yHigh = priceToCoordinate(zone.swingHigh);
        const yLow = priceToCoordinate(zone.swingLow);
        const startX = timeToCoordinate(zone.startTime as Time);

        if (yEq === null || yHigh === null || yLow === null || startX === null) continue;

        const endX = chartWidth;
        const width = endX - startX;
        if (width <= 0) continue;

        const isPrimary = zone.pairIndex === 0;
        // primary 用完整 alpha，secondary 整体淡一档
        const baseAlpha = isPrimary ? 1.0 : 0.5;
        const isCurrentSide = isPrimary; // 只有 primary pair 才"高亮"当前所在区

        const currentInPremium = isCurrentSide && zone.side === 'premium';
        const currentInDiscount = isCurrentSide && zone.side === 'discount';

        const premiumAlpha = (currentInPremium ? 0.10 : 0.05) * baseAlpha;
        const discountAlpha = (currentInDiscount ? 0.10 : 0.05) * baseAlpha;

        // 注：Premium/Discount 区域背景已关闭（用户反馈参考价值低）
        // 只保留 EQ 中线 + 标签

        // EQ 中线（金色虚线）
        const eqLineAlpha = isPrimary ? 0.7 : 0.35;
        ctx.strokeStyle = `rgba(234, 179, 8, ${eqLineAlpha})`;
        ctx.lineWidth = isPrimary ? 1.5 : 1;
        ctx.setLineDash([6, 4]);

        ctx.beginPath();
        ctx.moveTo(startX, yEq);
        ctx.lineTo(endX, yEq);
        ctx.stroke();

        ctx.setLineDash([]);

        // 标签（右侧）
        if (isPrimary) {
          ctx.font = 'bold 10px monospace';

          // EQ 标签背景 + 文字
          const eqText = `EQ ${zone.equilibrium.toFixed(2)}`;
          const eqTextWidth = ctx.measureText(eqText).width;
          const eqLabelX = endX - eqTextWidth - 10;
          const eqLabelY = yEq - 4;

          ctx.fillStyle = 'rgba(234, 179, 8, 0.18)';
          ctx.fillRect(eqLabelX - 4, eqLabelY - 11, eqTextWidth + 8, 16);

          ctx.fillStyle = `rgba(234, 179, 8, 0.95)`;
          ctx.fillText(eqText, eqLabelX, eqLabelY);

          // 左侧 pair 标识
          ctx.font = '9px monospace';
          ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
          const sideLabel =
            zone.side === 'premium' ? 'P' : zone.side === 'discount' ? 'D' : '=';
          const sideColor =
            zone.side === 'premium'
              ? 'rgba(239, 68, 68, 0.85)'
              : zone.side === 'discount'
              ? 'rgba(34, 197, 94, 0.85)'
              : 'rgba(107, 114, 128, 0.85)';
          ctx.fillStyle = sideColor;
          ctx.font = 'bold 10px monospace';
          ctx.fillText(sideLabel, startX + 6, yEq - 6);
        }
      }
    });
  }
}

class EquilibriumPaneView implements ISeriesPrimitivePaneView {
  private _renderer: EquilibriumPaneRenderer;
  private _data: EquilibriumRendererData | null = null;

  constructor() {
    this._renderer = new EquilibriumPaneRenderer();
  }

  update(data: EquilibriumRendererData): void {
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

export class EquilibriumPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: EquilibriumPaneView;
  private _zones: EquilibriumLevel[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new EquilibriumPaneView();
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

    const data: EquilibriumRendererData = {
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
   * Update Equilibrium zones data
   */
  setData(zones: EquilibriumLevel[]): void {
    this._zones = zones;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Get current Equilibrium zones
   */
  getData(): EquilibriumLevel[] {
    return this._zones;
  }
}
