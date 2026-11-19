/**
 * ICT Setup Primitive for Lightweight Charts v4
 *
 * 画出当前 ICT Setup 状态机的关键位：
 * - POI 回踩区（OB / FVG / OTE）半透明矩形 + 上下虚线
 * - 入场线（白虚线）
 * - 止损线（红实线）
 * - 目标线（绿虚线，TP1 / TP2）
 *
 * 只画「当前这一个 setup」，不铺满图表。
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

/** 图上要画的一条 setup */
export interface IctSetupRenderItem {
  direction: 'bullish' | 'bearish';
  state: string;
  /** 流动性池（等高/等低/前高前低）—— 待扫的猎物位 */
  pool?: { level: number; label: string };
  poi?: { type: string; high: number; low: number; startTime: number };
  entry?: number;
  stopLoss?: number;
  targets?: { price: number; label: string }[];
}

interface IctSetupRendererData {
  items: IctSetupRenderItem[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class IctSetupPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: IctSetupRendererData | null = null;

  update(data: IctSetupRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.items.length === 0) return;

    const { items, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const item of items) {
        const isBullish = item.direction === 'bullish';
        const baseColor = isBullish ? '6, 182, 212' : '249, 115, 22';
        const isReady = item.state === 'ready';

        // ── 流动性池位（待扫的猎物）────────────────
        if (item.pool) {
          const y = priceToCoordinate(item.pool.level);
          if (y !== null) {
            ctx.strokeStyle = 'rgba(234, 179, 8, 0.75)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(chartWidth, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.font = '9px monospace';
            ctx.fillStyle = 'rgba(234, 179, 8, 0.95)';
            ctx.fillText(item.pool.label, chartWidth - 92, y - 3);
          }
        }

        // ── POI 区域 ──────────────────────────────
        if (item.poi) {
          const startX = timeToCoordinate(item.poi.startTime as Time);
          const yHigh = priceToCoordinate(item.poi.high);
          const yLow = priceToCoordinate(item.poi.low);
          if (startX !== null && yHigh !== null && yLow !== null) {
            const top = Math.min(yHigh, yLow);
            const bottom = Math.max(yHigh, yLow);
            const height = Math.max(bottom - top, 1);
            const width = chartWidth - startX;
            if (width > 0) {
              ctx.fillStyle = `rgba(${baseColor}, ${isReady ? 0.18 : 0.08})`;
              ctx.fillRect(startX, top, width, height);

              ctx.strokeStyle = `rgba(${baseColor}, ${isReady ? 0.6 : 0.3})`;
              ctx.lineWidth = 1;
              ctx.setLineDash([4, 4]);
              ctx.beginPath();
              ctx.moveTo(startX, top);
              ctx.lineTo(chartWidth, top);
              ctx.stroke();
              ctx.beginPath();
              ctx.moveTo(startX, bottom);
              ctx.lineTo(chartWidth, bottom);
              ctx.stroke();
              ctx.setLineDash([]);

              ctx.font = 'bold 10px monospace';
              ctx.fillStyle = `rgba(${baseColor}, 0.9)`;
              const tag = `POI ${item.poi.type.toUpperCase()}`;
              ctx.fillText(tag, startX + 4, top + 12);
            }
          }
        }

        // ── 入场线 ────────────────────────────────
        if (item.entry !== undefined) {
          const y = priceToCoordinate(item.entry);
          if (y !== null) {
            ctx.strokeStyle = 'rgba(226, 232, 240, 0.75)';
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(chartWidth, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.font = '9px monospace';
            ctx.fillStyle = 'rgba(226, 232, 240, 0.9)';
            ctx.fillText('入场', chartWidth - 46, y - 3);
          }
        }

        // ── 止损线 ────────────────────────────────
        if (item.stopLoss !== undefined) {
          const y = priceToCoordinate(item.stopLoss);
          if (y !== null) {
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(chartWidth, y);
            ctx.stroke();
            ctx.font = '9px monospace';
            ctx.fillStyle = 'rgba(239, 68, 68, 0.95)';
            ctx.fillText('SL', chartWidth - 46, y - 3);
          }
        }

        // ── 目标线 ────────────────────────────────
        item.targets?.forEach((t, i) => {
          const y = priceToCoordinate(t.price);
          if (y === null) return;
          ctx.strokeStyle = 'rgba(34, 197, 94, 0.8)';
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(chartWidth, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = '9px monospace';
          ctx.fillStyle = 'rgba(34, 197, 94, 0.95)';
          ctx.fillText(`TP${i + 1}`, chartWidth - 46, y - 3);
        });
      }
    });
  }
}

class IctSetupPaneView implements ISeriesPrimitivePaneView {
  private _renderer: IctSetupPaneRenderer;
  private _data: IctSetupRendererData | null = null;

  constructor() {
    this._renderer = new IctSetupPaneRenderer();
  }

  update(data: IctSetupRendererData): void {
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

export class IctSetupPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: IctSetupPaneView;
  private _items: IctSetupRenderItem[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new IctSetupPaneView();
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

    const data: IctSetupRendererData = {
      items: this._items,
      priceToCoordinate: (price: number) => this._series!.priceToCoordinate(price),
      timeToCoordinate: (time: Time) => timeScale.timeToCoordinate(time),
      chartWidth: timeScale.width(),
    };

    this._paneView.update(data);
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  /** 更新要画的 setup */
  setData(items: IctSetupRenderItem[]): void {
    this._items = items;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  getData(): IctSetupRenderItem[] {
    return this._items;
  }
}
