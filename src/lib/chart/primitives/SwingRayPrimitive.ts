/**
 * Swing Ray Primitive for Lightweight Charts v4
 *
 * 画「最新的 LL / HH」水平虚射线:
 * - 从最新 swing high(记作 HH)的价格水平,向左画一条橙色虚射线到图表左边缘
 * - 从最新 swing low(记作 LL)的价格水平,向左画一条蓝色虚射线到图表左边缘
 *
 * 两条线都画在 pane 的最底层(zOrder='bottom'),不遮挡 K 线;
 * 左端各带一个 "HH" / "LL" 标签(与图上 swing point 标记的文字一致),用来区分颜色含义。
 */

import {
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesPrimitivePaneViewZOrder,
  Time,
  Coordinate,
  SeriesAttachedParameter,
} from "lightweight-charts";
import type { IChartApiBase } from "lightweight-charts";
import { CanvasRenderingTarget2D } from "fancy-canvas";

/** 一条射线 —— 从某个 swing 点向左延伸的水平虚线 */
export interface SwingRay {
  /** "HH" = 最新 swing high,"LL" = 最新 swing low */
  label: "HH" | "LL";
  /** 射线所在的价格水平(swing 点的价格) */
  price: number;
  /** swing 点所在时间(用于算射线的右端 x) */
  time: number;
}

interface SwingRayRendererData {
  rays: SwingRay[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
}

const COLORS = {
  /** LL —— 亮蓝 */
  LL: {
    line: "rgba(0, 191, 255, 0.85)",
    text: "rgba(0, 191, 255, 1)",
  },
  /** HH —— 亮橙 */
  HH: {
    line: "rgba(255, 149, 0, 0.85)",
    text: "rgba(255, 149, 0, 1)",
  },
} as const;

class SwingRayPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: SwingRayRendererData | null = null;

  update(data: SwingRayRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.rays.length === 0) return;

    const { rays, priceToCoordinate, timeToCoordinate } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const ray of rays) {
        const y = priceToCoordinate(ray.price);
        const x = timeToCoordinate(ray.time as Time);
        // swing 点不在可视范围内时(x 为 null 或跑到画布外)不画
        if (y === null || x === null || x <= 0) continue;

        const color = COLORS[ray.label];

        // 水平虚线:从左边缘(0)画到 swing 点的 x —— 向左延伸
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(x, y);
        ctx.strokeStyle = color.line;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // 左端标签(靠左边缘,标注这条线是 HH 还是 LL)
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.strokeText(ray.label, 4, y - 2);
        ctx.fillStyle = color.text;
        ctx.fillText(ray.label, 4, y - 2);
        ctx.textBaseline = "alphabetic";
      }
    });
  }
}

class SwingRayPaneView implements ISeriesPrimitivePaneView {
  private _renderer: SwingRayPaneRenderer;
  private _data: SwingRayRendererData | null = null;

  constructor() {
    this._renderer = new SwingRayPaneRenderer();
  }

  update(data: SwingRayRendererData): void {
    this._data = data;
    this._renderer.update(data);
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    // 最底层,不遮挡 K 线
    return "bottom";
  }
}

export class SwingRayPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: SwingRayPaneView;
  private _rays: SwingRay[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new SwingRayPaneView();
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

    const data: SwingRayRendererData = {
      rays: this._rays,
      priceToCoordinate: (price: number) => this._series!.priceToCoordinate(price),
      timeToCoordinate: (time: Time) => timeScale.timeToCoordinate(time),
    };

    this._paneView.update(data);
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  setData(rays: SwingRay[]): void {
    this._rays = rays;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  getData(): SwingRay[] {
    return this._rays;
  }
}
