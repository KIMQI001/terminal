/**
 * KeyLevels Primitive for Lightweight Charts v4
 *
 * 在特定 K 线周围画金框 + 标签，用于标记结构性 HH/LL（前一高/前低）
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

export interface KeyLevel {
  time: number;
  high: number;
  low: number;
  label?: string;
}

interface KeyLevelsRendererData {
  levels: KeyLevel[];
  timeToCoordinate: (time: Time) => Coordinate | null;
  priceToCoordinate: (price: number) => Coordinate | null;
  chartHeight: number;
  chartWidth: number;
}

class KeyLevelsPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: KeyLevelsRendererData | null = null;

  update(data: KeyLevelsRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data) return;
    const { levels, timeToCoordinate, priceToCoordinate, chartWidth } = this._data;
    if (levels.length === 0) return;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const level of levels) {
        const x = timeToCoordinate(level.time as Time);
        if (x === null) continue;
        // 上下 padding 让框比 K 线高一点
        const yHigh = priceToCoordinate(level.high);
        const yLow = priceToCoordinate(level.low);
        if (yHigh === null || yLow === null) continue;
        const padding = 3;
        const top = Math.min(yHigh, yLow) - padding;
        const bottom = Math.max(yHigh, yLow) + padding;
        const height = bottom - top;

        // 金色矩形框（不填充只描边）
        const halfWidth = 6; // K 线半宽
        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 2;
        ctx.strokeRect(x - halfWidth, top, halfWidth * 2, height);

        // 标签
        if (level.label) {
          ctx.font = 'bold 10px monospace';
          ctx.fillStyle = '#eab308';
          const textWidth = ctx.measureText(level.label).width;
          const labelX = x + halfWidth + 4;
          const labelY = top - 2;
          // 文字背景（半透明白）
          ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.fillRect(labelX - 2, labelY - 10, textWidth + 4, 14);
          ctx.fillStyle = '#eab308';
          ctx.fillText(level.label, labelX, labelY);
        }
      }
    });
  }
}

class KeyLevelsPaneView implements ISeriesPrimitivePaneView {
  private _renderer: KeyLevelsPaneRenderer;
  private _data: KeyLevelsRendererData | null = null;

  constructor() {
    this._renderer = new KeyLevelsPaneRenderer();
  }

  update(data: KeyLevelsRendererData): void {
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

export class KeyLevelsPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: KeyLevelsPaneView;
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;
  private _levels: KeyLevel[] = [];

  constructor() {
    this._paneView = new KeyLevelsPaneView();
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

    const data: KeyLevelsRendererData = {
      levels: this._levels,
      timeToCoordinate: (time: Time) => timeScale.timeToCoordinate(time),
      priceToCoordinate: (price: number) => this._series!.priceToCoordinate(price),
      chartHeight: this._chart.chartElement().clientHeight,
      chartWidth: timeScale.width(),
    };

    this._paneView.update(data);
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  setLevels(levels: KeyLevel[]): void {
    this._levels = levels;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  getLevels(): KeyLevel[] {
    return this._levels;
  }
}
