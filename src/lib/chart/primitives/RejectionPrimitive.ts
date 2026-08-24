/**
 * Rejection Zone Primitive for Lightweight Charts v4
 *
 * 绘制 wick 中点的"actionable level"射线:
 * - bullish(下影/支撑):浅蓝,level = (low + bodyBottom) / 2
 * - bearish(上影/阻力):浅橙,level = (bodyTop + high) / 2
 *
 * 实时语义:
 * - 后续任一 K 的 range 包住 level(low <= level <= high)→ 该 zone 已被测试过
 *   → 立即擦掉(从 chart 消失)
 * - 最后一根 K(进行中)也算 tester → 当前 tick 一碰 level,该 zone 立刻消失
 * - 最后一根不作为 wick 来源
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
import { Rejection } from '@/types/indicator';
import { Candle } from '@/types/chart';
import { isWickTested } from '@/lib/chart/indicators/rejection';

interface RejectionRendererData {
  rejections: Rejection[];
  candles: Candle[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
}

class RejectionPaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: RejectionRendererData | null = null;

  update(data: RejectionRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data || this._data.rejections.length === 0) return;

    const { rejections, candles, priceToCoordinate, timeToCoordinate, chartWidth } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const r of rejections) {
        // 实时检测:被后续 K 测试过 → 不画
        if (isWickTested(r, candles)) continue;

        const yLevel = priceToCoordinate(r.level);
        const startX = timeToCoordinate(r.time as Time);
        if (yLevel === null || startX === null) continue;

        const endX = chartWidth;
        if (endX <= startX) continue;

        const isBullish = r.type === 'bullish';
        // 看涨:浅蓝(下影/支撑 S)
        // 看跌:紫色 + 白字 + 黑描边(上影/阻力 R)— 红/绿背景下都强对比
        const lineColor = isBullish ? 'rgba(96, 165, 250, 0.9)' : 'rgba(192, 132, 252, 0.95)';

        // 中线射线(虚线)
        ctx.beginPath();
        ctx.moveTo(startX, yLevel);
        ctx.lineTo(endX, yLevel);
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // 左侧 "S1/R1" "S2/R2" 标签(支撑/阻力 + 层级)
        // 加大字号 + 黑色描边,任何背景下都清晰
        const label = isBullish ? `S${r.tier}` : `R${r.tier}`;
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        // 黑色描边(在所有背景上都看得见)
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeText(label, startX + 4, yLevel + 3);
        // 紫色填充(看跌)/ 蓝色填充(看涨)
        ctx.fillStyle = isBullish
          ? 'rgba(224, 242, 254, 1)'     // blue-50 浅蓝文字
          : 'rgba(245, 230, 255, 1)';    // purple-50 浅紫文字
        ctx.fillText(label, startX + 4, yLevel + 3);
        ctx.textAlign = 'start';
      }
    });
  }
}

class RejectionPaneView implements ISeriesPrimitivePaneView {
  private _renderer: RejectionPaneRenderer;
  private _data: RejectionRendererData | null = null;

  constructor() {
    this._renderer = new RejectionPaneRenderer();
  }

  update(data: RejectionRendererData): void {
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

export class RejectionPrimitive implements ISeriesPrimitive<Time> {
  private _paneView: RejectionPaneView;
  private _rejections: Rejection[] = [];
  private _candles: Candle[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new RejectionPaneView();
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

    const data: RejectionRendererData = {
      rejections: this._rejections,
      candles: this._candles,
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
   * Update Rejections + K线(用于实时 isTested 检测)
   */
  setData(rejections: Rejection[], candles: Candle[] = []): void {
    this._rejections = rejections;
    this._candles = candles;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  getData(): Rejection[] {
    return this._rejections;
  }
}
