/**
 * Swing Ray Primitive for Lightweight Charts v4
 *
 * 画「最近的 HH / LL」水平虚射线(默认最近 5 个 HH + 5 个 LL):
 * - 从每个 swing high(记作 HH)的价格水平,向左画一条橙色虚射线到图表左边缘
 * - 从每个 swing low(记作 LL)的价格水平,向左画一条蓝色虚射线到图表左边缘
 *
 * 所有线都画在 pane 的最底层(zOrder='bottom'),不遮挡 K 线;
 * 左端各带一个 "HH" / "LL" 标签(与图上 swing point 标记的文字一致),用来区分颜色含义。
 * 越旧的射线透明度越低,最近的最高 —— 避免多条同色线糊成一片。
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

/** 每个方向(HH / LL)最多画几条射线 */
export const SWING_RAY_COUNT = 5;

/** 一条射线 —— 从某个 swing 点向左延伸的水平虚线 */
export interface SwingRay {
  /** "HH" = swing high,"LL" = swing low */
  label: "HH" | "LL";
  /** 射线所在的价格水平(swing 点的价格) */
  price: number;
  /** swing 点所在时间(用于算射线的右端 x) */
  time: number;
  /** 0 = 最近的一个,越往后越旧 —— 用于递减透明度 */
  age: number;
}

interface SwingRayRendererData {
  rays: SwingRay[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
}

const COLORS = {
  /** LL —— 亮蓝 */
  LL: { r: 0, g: 191, b: 255 },
  /** HH —— 亮橙 */
  HH: { r: 255, g: 149, b: 0 },
} as const;

/** 最新的射线最不透明,每旧一条衰减一档 */
const ALPHA_BASE = 0.85;
const ALPHA_STEP = 0.15;
const ALPHA_MIN = 0.3;

function alphaOf(age: number): number {
  return Math.max(ALPHA_MIN, ALPHA_BASE - age * ALPHA_STEP);
}


class SwingRayPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: SwingRayRendererData | null = null;

  update(data: SwingRayRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.rays.length === 0) return;

    const { rays, priceToCoordinate, timeToCoordinate } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const ray of rays) {
        const y = priceToCoordinate(ray.price);
        const x = timeToCoordinate(ray.time as Time);
        // swing 点没有对应时间数据时无法定位,跳过
        if (y === null || x === null) continue;

        const color = COLORS[ray.label];
        const alpha = alphaOf(ray.age);

        // 射线右端:swing 点的 x;swing 点在可视区左边时,整条可视区域都在它左侧,画满宽
        const endX = Math.min(Math.max(x, 0), mediaSize.width);

        // 水平虚线:从左边缘(0)画到 swing 点的 x —— 向左延伸
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(endX, y);
        ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
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
        ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
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
