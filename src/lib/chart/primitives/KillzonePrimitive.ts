/**
 * Killzone Primitive for Lightweight Charts v4
 *
 * 画法（OTE 块风格）：
 * 1. 找当前 session（如 London 15:00-20:00 北京）
 * 2. 找 session 内的 K 线
 * 3. 算 high/low 极值
 * 4. 框起来填充（从 first K 线到 last K 线，high 到 low）
 *
 * 4 个 session：
 * - Asian:  00:00-06:00 UTC (08:00-14:00 北京)
 * - London: 07:00-12:00 UTC (15:00-20:00 北京)
 * - NY AM:  12:00-15:00 UTC (20:00-23:00 北京)
 * - NY PM:  15:00-21:00 UTC (23:00-05:00 北京)
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
import { Killzone } from '@/types/indicator';
import { Candle } from '@/types/chart';

const DEFAULT_KILLZONES: Killzone[] = [
  { name: 'asian', startHour: 0, endHour: 6, color: 'rgba(147, 51, 234, 0.12)' },
  { name: 'london', startHour: 7, endHour: 12, color: 'rgba(59, 130, 246, 0.12)' },
  { name: 'ny-am', startHour: 12, endHour: 15, color: 'rgba(34, 197, 94, 0.12)' },
  { name: 'ny-pm', startHour: 15, endHour: 21, color: 'rgba(249, 115, 22, 0.12)' },
];

interface KillzoneRendererData {
  candles: Candle[];              // 当前 chart 周期所有 K 线
  timeToCoordinate: (time: Time) => Coordinate | null;
  priceToCoordinate: (price: number) => Coordinate | null;
  chartHeight: number;
  chartWidth: number;
}

class KillzonePaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: KillzoneRendererData | null = null;

  update(data: KillzoneRendererData): void {
    this._data = data;
  }

  /** 找当前 session；endSec = MIN(session_end, now) live */
  private getCurrentSession(nowSec: number): { kz: Killzone; startSec: number; endSec: number } | null {
    const todayMidnight = Math.floor(nowSec / 86400) * 86400;
    for (const kz of DEFAULT_KILLZONES) {
      const startSec = todayMidnight + kz.startHour * 3600;
      let endSec = todayMidnight + kz.endHour * 3600;
      if (kz.endHour === 24) endSec = todayMidnight + 86400;
      if (nowSec >= startSec && nowSec < endSec) {
        return { kz, startSec, endSec: Math.min(endSec, nowSec) };
      }
    }
    return null;
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    if (!this._data) return;
    const { candles, timeToCoordinate, priceToCoordinate, chartHeight, chartWidth } = this._data;
    if (candles.length === 0) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const session = this.getCurrentSession(nowSec);
    if (!session) return;

    const { kz, startSec, endSec } = session;

    // 1. 找 session 时间范围内的 K 线
    const sessionCandles = candles.filter(
      (c) => c.time >= startSec && c.time <= endSec
    );
    if (sessionCandles.length === 0) return;

    // 2. 算 high/low 极值
    let high = -Infinity;
    let low = Infinity;
    for (const c of sessionCandles) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
    }
    if (high === -Infinity || low === Infinity) return;

    // 3. 找 first/last K 线的 time（用 visible 区域 clip）
    const firstTime = sessionCandles[0].time;
    const lastTime = sessionCandles[sessionCandles.length - 1].time;

    // 4. 转成坐标
    const xStart = timeToCoordinate(firstTime as Time);
    const xEnd = timeToCoordinate(lastTime as Time);
    const yHigh = priceToCoordinate(high);
    const yLow = priceToCoordinate(low);

    if (xStart === null || xEnd === null || yHigh === null || yLow === null) return;
    if (xEnd <= xStart) return;

    // 5. Clip 到 chart 范围内（防止画到"未来"区域）
    const xDrawStart = Math.max(0, xStart);
    const xDrawEnd = Math.min(chartWidth, xEnd);

    // 6. 画矩形填充 + EQ 虚线
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const width = xDrawEnd - xDrawStart;
      const height = yLow - yHigh;
      if (width <= 0 || height <= 0) return;

      // 矩形背景
      ctx.fillStyle = kz.color;
      ctx.fillRect(xDrawStart, yHigh, width, height);

      // EQ 虚线（横穿矩形中部）
      const eqPrice = (high + low) / 2;
      const yEq = priceToCoordinate(eqPrice);
      if (yEq !== null) {
        const lineColor = kz.color.replace(/[\d.]+\)$/, '0.55)');
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(xDrawStart, yEq);
        ctx.lineTo(xDrawEnd, yEq);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  }

  draw(): void {
    // 主绘制在 drawBackground
  }
}

class KillzonePaneView implements ISeriesPrimitivePaneView {
  private _renderer: KillzonePaneRenderer;
  private _data: KillzoneRendererData | null = null;

  constructor() {
    this._renderer = new KillzonePaneRenderer();
  }

  update(data: KillzoneRendererData): void {
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

export class KillzonePrimitive implements ISeriesPrimitive<Time> {
  private _paneView: KillzonePaneView;
  private _killzones: Killzone[] = DEFAULT_KILLZONES;
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>['series'] | null = null;
  private _requestUpdate?: () => void;
  private _candles: Candle[] = [];

  constructor() {
    this._paneView = new KillzonePaneView();
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

    const data: KillzoneRendererData = {
      candles: this._candles,
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

  /** TradingChart 调用：传入当前周期所有 K 线 */
  setCandles(candles: Candle[]): void {
    this._candles = candles;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  setData(killzones: Killzone[]): void {
    this._killzones = killzones.length > 0 ? killzones : DEFAULT_KILLZONES;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled) {
      this._killzones = DEFAULT_KILLZONES;
    } else {
      this._killzones = [];
    }
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  getData(): Killzone[] {
    return this._killzones;
  }
}
