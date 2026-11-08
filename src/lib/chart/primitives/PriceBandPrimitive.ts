/**
 * Price Band Primitive for Lightweight Charts v4
 *
 * 绘制价格带(Price Band):
 * - 每个价位向外扩 ±halfWidth,形成一条横跨整个图表的价格带(半透明矩形)
 * - 阻力带(现价上方)红色系,标 R1(最近) ~ Rn(最远)
 * - 支撑带(现价下方)绿色系,标 S1(最近) ~ Sn(最远)
 * - 左侧标序号,右侧标价位
 *
 * 数据来源:src/lib/chart/priceBand.ts —— 由月K 的 open/close + 阴K low + 阳K high 推导
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
import type { PriceBandLevel, PriceBandSide } from '@/lib/chart/priceBand';

interface PriceBandRendererData {
  bands: Array<PriceBandLevel & { side: PriceBandSide; rank: number }>;
  priceToCoordinate: (price: number) => Coordinate | null;
  chartWidth: number;
}

const COLORS = {
  resistance: {
    fill: 'rgba(239, 68, 68, 0.10)',
    border: 'rgba(239, 68, 68, 0.55)',
    text: 'rgba(254, 202, 202, 1)',
  },
  support: {
    fill: 'rgba(34, 197, 94, 0.10)',
    border: 'rgba(34, 197, 94, 0.55)',
    text: 'rgba(187, 247, 208, 1)',
  },
} as const;

class PriceBandPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: PriceBandRendererData | null = null;

  update(data: PriceBandRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.bands.length === 0) return;

    const { bands, priceToCoordinate, chartWidth } = this._data;
    if (chartWidth <= 0) return;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      // 先画所有价格带
      const leftLabels: Array<{ y: number; text: string; color: string }> = [];
      const rightLabels: Array<{ y: number; text: string; color: string }> = [];

      for (const band of bands) {
        const yTop = priceToCoordinate(band.upper);
        const yBottom = priceToCoordinate(band.lower);
        if (yTop === null || yBottom === null) continue;

        const top = Math.min(yTop, yBottom);
        const height = Math.abs(yBottom - yTop);
        if (height <= 0) continue;

        const c = COLORS[band.side];

        // 半透明矩形(整条价格带)
        ctx.fillStyle = c.fill;
        ctx.fillRect(0, top, chartWidth, height);

        // 上下边界虚线
        ctx.strokeStyle = c.border;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(0, top);
        ctx.lineTo(chartWidth, top);
        ctx.moveTo(0, top + height);
        ctx.lineTo(chartWidth, top + height);
        ctx.stroke();
        ctx.setLineDash([]);

        const midY = top + height / 2;
        // 左侧序号:阻力 R1..Rn / 支撑 S1..Sn
        leftLabels.push({
          y: midY,
          text: `${band.side === 'resistance' ? 'R' : 'S'}${band.rank}`,
          color: c.text,
        });
        // 右侧价位
        rightLabels.push({
          y: midY,
          text: band.price.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }),
          color: c.text,
        });
      }

      ctx.font = 'bold 11px monospace';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';

      // 左侧序号(防重叠)
      const leftYs = deconflict(leftLabels.map((l) => l.y), 13);
      ctx.textAlign = 'left';
      leftLabels.forEach((l, i) => {
        ctx.strokeText(l.text, 4, leftYs[i] + 1);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, 4, leftYs[i] + 1);
      });

      // 右侧价位(防重叠)
      const rightYs = deconflict(rightLabels.map((l) => l.y), 13);
      ctx.textAlign = 'right';
      rightLabels.forEach((l, i) => {
        ctx.strokeText(l.text, chartWidth - 4, rightYs[i] + 1);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, chartWidth - 4, rightYs[i] + 1);
      });
      ctx.textAlign = 'start';
    });
  }
}

/**
 * 标签防重叠:按 y 升序排,相邻标签间距不足 minGap 时依次往下推。
 * 返回与入参一一对应的新 y 坐标。
 */
function deconflict(ys: number[], minGap: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  let prev = -Infinity;
  for (const item of order) {
    item.y = Math.max(item.y, prev + minGap);
    prev = item.y;
  }
  const out = new Array<number>(ys.length);
  for (const item of order) out[item.i] = item.y;
  return out;
}

class PriceBandPaneView implements ISeriesPrimitivePaneView {
  private _renderer: PriceBandPaneRenderer;
  private _data: PriceBandRendererData | null = null;

  constructor() {
    this._renderer = new PriceBandPaneRenderer();
  }

  update(data: PriceBandRendererData): void {
    this._data = data;
    this._renderer.update(data);
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    // 画在 K 线下方,避免遮挡蜡烛
    return 'bottom';
  }
}

export class PriceBandPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: PriceBandPaneView;
  private _bands: Array<PriceBandLevel & { side: PriceBandSide; rank: number }> = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new PriceBandPaneView();
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

    const data: PriceBandRendererData = {
      bands: this._bands,
      priceToCoordinate: (price: number) => this._series!.priceToCoordinate(price),
      chartWidth: timeScale.width(),
    };

    this._paneView.update(data);
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  /**
   * 设置价格带。
   * @param resistances 上方阻力带(升序:最近 → 最远)
   * @param supports 下方支撑带(降序:最近 → 最远)
   */
  setData(resistances: PriceBandLevel[], supports: PriceBandLevel[]): void {
    this._bands = [
      ...resistances.map((b, i) => ({ ...b, side: 'resistance' as PriceBandSide, rank: i + 1 })),
      ...supports.map((b, i) => ({ ...b, side: 'support' as PriceBandSide, rank: i + 1 })),
    ];
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  getData(): Array<PriceBandLevel & { side: PriceBandSide; rank: number }> {
    return this._bands;
  }
}
