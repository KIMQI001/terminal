/**
 * Killzone Primitive for Lightweight Charts v4
 *
 * Draws vertical time-based region for the CURRENT ICT session only:
 * - Asian Session:  00:00-06:00 UTC (08:00-14:00 北京) — Tokyo
 * - London Session: 07:00-12:00 UTC (15:00-20:00 北京) — London open to NY pre-open
 * - NY AM Session: 12:00-15:00 UTC (20:00-23:00 北京) — NY morning
 * - NY PM Session: 15:00-21:00 UTC (23:00-05:00 北京) — NY afternoon
 *
 * Only the session containing the current real time is drawn.
 * 1h gap between Asian and London (14:00-15:00 北京) = no session.
 */

import {
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesPrimitivePaneViewZOrder,
  Time,
  Coordinate,
  SeriesAttachedParameter,
  LogicalRange,
  Logical,
} from 'lightweight-charts';
import type { IChartApiBase } from 'lightweight-charts';
import { CanvasRenderingTarget2D } from 'fancy-canvas';
import { Killzone } from '@/types/indicator';

// Default Killzones (times in UTC hours)
const DEFAULT_KILLZONES: Killzone[] = [
  { name: 'asian', startHour: 0, endHour: 6, color: 'rgba(147, 51, 234, 0.28)' }, // Purple - Asian (Tokyo)
  { name: 'london', startHour: 7, endHour: 12, color: 'rgba(59, 130, 246, 0.28)' }, // Blue - London
  { name: 'ny-am', startHour: 12, endHour: 15, color: 'rgba(34, 197, 94, 0.28)' }, // Green - NY AM
  { name: 'ny-pm', startHour: 15, endHour: 21, color: 'rgba(249, 115, 22, 0.28)' }, // Orange - NY PM
];

interface KillzoneRendererData {
  killzones: Killzone[];
  visibleRange: LogicalRange | null;
  logicalToCoordinate: (logical: Logical) => Coordinate | null;
  chartHeight: number;
  chartWidth: number;
  firstVisibleTime: number | null;
  lastVisibleTime: number | null;
  lastCandleTime: number | null;  // 最后一根 K 线的时间（用于 cap 防止画到"未来"区域）
  candleInterval: number; // Time interval between candles in seconds
}

class KillzonePaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: KillzoneRendererData | null = null;

  update(data: KillzoneRendererData): void {
    this._data = data;
  }

  /**
   * 根据"现在"找当前所处的 killzone（如果不在任何 session 内返回 null）
   * endSec = min(session_end, now)：session 进行中时只画到当前（live 模式）
   */
  private getCurrentSession(nowSec: number): { kz: Killzone; startSec: number; endSec: number } | null {
    const todayMidnight = Math.floor(nowSec / 86400) * 86400;
    for (const kz of DEFAULT_KILLZONES) {
      let startSec = todayMidnight + kz.startHour * 3600;
      let endSec = todayMidnight + kz.endHour * 3600;
      if (kz.endHour === 24) endSec = todayMidnight + 86400;
      if (nowSec >= startSec && nowSec < endSec) {
        // live 模式：endSec = 当前时间（session 还没结束就到这里）
        return { kz, startSec, endSec: Math.min(endSec, nowSec) };
      }
    }
    return null;
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    if (!this._data) return;
    const {
      firstVisibleTime,
      lastVisibleTime,
      lastCandleTime,
      chartHeight,
      candleInterval,
      logicalToCoordinate,
      visibleRange,
    } = this._data;

    if (!firstVisibleTime || !lastVisibleTime || !visibleRange) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const session = this.getCurrentSession(nowSec);
    if (!session) return;

    const { kz, startSec, endSec } = session;

    // session 在可见范围之外则不画
    if (endSec < firstVisibleTime || startSec > lastVisibleTime) return;

    // endSec cap 到 lastCandleTime（防止画到最后一根 K 线右侧的"未来"区域）
    const effectiveEndSec = lastCandleTime
      ? Math.min(endSec, lastCandleTime)
      : endSec;
    if (effectiveEndSec <= startSec) return; // 区间无效

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const startLogical = Math.max(
        (startSec - firstVisibleTime) / candleInterval + visibleRange.from,
        visibleRange.from
      );
      const endLogical = Math.min(
        (effectiveEndSec - firstVisibleTime) / candleInterval + visibleRange.from,
        visibleRange.to
      );

      const x1 = logicalToCoordinate(startLogical as Logical);
      const x2 = logicalToCoordinate(endLogical as Logical);

      if (x1 === null || x2 === null) return;

      const width = Math.abs(x2 - x1);
      if (width <= 0) return;

      ctx.fillStyle = kz.color;
      ctx.fillRect(Math.min(x1, x2), 0, width, chartHeight);
    });
  }

  draw(): void {
    // Main drawing is done in drawBackground
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
  private _candleInterval: number = 3600; // Default 1h
  private _lastCandleTime: number | null = null;  // 最后一根 K 线时间（防止画到"未来"区域）

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
    const visibleRange = timeScale.getVisibleLogicalRange();

    // Get first and last visible times
    let firstVisibleTime: number | null = null;
    let lastVisibleTime: number | null = null;

    if (visibleRange) {
      const fromCoord = timeScale.logicalToCoordinate(visibleRange.from);
      const toCoord = timeScale.logicalToCoordinate(visibleRange.to);

      if (fromCoord !== null) {
        const fromTime = timeScale.coordinateToTime(fromCoord);
        if (fromTime !== null && typeof fromTime === 'number') {
          firstVisibleTime = fromTime;
        }
      }
      if (toCoord !== null) {
        const toTime = timeScale.coordinateToTime(toCoord);
        if (toTime !== null && typeof toTime === 'number') {
          lastVisibleTime = toTime;
        }
      }
    }

    const data: KillzoneRendererData = {
      killzones: this._killzones,
      visibleRange,
      logicalToCoordinate: (logical: Logical) => timeScale.logicalToCoordinate(logical),
      chartHeight: this._chart.chartElement().clientHeight,
      chartWidth: timeScale.width(),
      firstVisibleTime,
      lastVisibleTime,
      lastCandleTime: this._lastCandleTime,
      candleInterval: this._candleInterval,
    };

    this._paneView.update(data);
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  /**
   * Set candle interval in seconds (needed to calculate time positions)
   */
  setCandleInterval(interval: number): void {
    this._candleInterval = interval;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Update Killzones configuration
   */
  setData(killzones: Killzone[]): void {
    this._killzones = killzones.length > 0 ? killzones : DEFAULT_KILLZONES;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * 设置最后一根 K 线的时间（用于 cap killzone 范围）
   */
  setLastCandleTime(time: number | null): void {
    this._lastCandleTime = time;
    if (this._requestUpdate) {
      this._requestUpdate();
    }
  }

  /**
   * Enable or disable the killzones display
   */
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

  /**
   * Get current Killzones
   */
  getData(): Killzone[] {
    return this._killzones;
  }
}
