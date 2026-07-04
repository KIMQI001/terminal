/**
 * Killzone Primitive for Lightweight Charts v4
 *
 * Draws vertical time-based regions for ICT Killzones:
 * - Asian Session: 20:00-00:00 UTC (8pm-12am)
 * - London Session: 02:00-05:00 UTC (2am-5am)
 * - NY AM: 12:00-15:00 UTC (12pm-3pm)
 * - NY PM: 18:00-21:00 UTC (6pm-9pm)
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
  { name: 'asian', startHour: 20, endHour: 24, color: 'rgba(147, 51, 234, 0.12)' }, // Purple - Asian Session
  { name: 'london', startHour: 2, endHour: 5, color: 'rgba(59, 130, 246, 0.12)' }, // Blue - London Session
  { name: 'ny-am', startHour: 12, endHour: 15, color: 'rgba(34, 197, 94, 0.12)' }, // Green - NY AM Session
  { name: 'ny-pm', startHour: 18, endHour: 21, color: 'rgba(249, 115, 22, 0.12)' }, // Orange - NY PM Session
];

interface KillzoneRendererData {
  killzones: Killzone[];
  visibleRange: LogicalRange | null;
  logicalToCoordinate: (logical: Logical) => Coordinate | null;
  chartHeight: number;
  chartWidth: number;
  firstVisibleTime: number | null;
  lastVisibleTime: number | null;
  candleInterval: number; // Time interval between candles in seconds
}

class KillzonePaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: KillzoneRendererData | null = null;

  update(data: KillzoneRendererData): void {
    this._data = data;
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    if (!this._data) return;
    const {
      killzones,
      firstVisibleTime,
      lastVisibleTime,
      chartHeight,
      candleInterval,
      logicalToCoordinate,
      visibleRange,
    } = this._data;

    if (!firstVisibleTime || !lastVisibleTime || !visibleRange) return;

    target.useMediaCoordinateSpace(({ context: ctx }) => {
      // Calculate the day boundaries in the visible range
      const startDay = Math.floor(firstVisibleTime / 86400) * 86400;
      const endDay = Math.ceil(lastVisibleTime / 86400) * 86400;

      for (let dayStart = startDay; dayStart <= endDay; dayStart += 86400) {
        for (const kz of killzones) {
          // Handle zones that cross midnight
          let kzStart = dayStart + kz.startHour * 3600;
          let kzEnd = dayStart + kz.endHour * 3600;

          // If endHour is 24 (midnight), it means end of day
          if (kz.endHour === 24) {
            kzEnd = dayStart + 86400; // End of this day
          }

          // If startHour > endHour, zone crosses midnight (e.g., 20:00-00:00)
          // This case is already handled by endHour being 24

          // Skip if zone is outside visible range
          if (kzEnd < firstVisibleTime || kzStart > lastVisibleTime) continue;

          // Convert times to logical coordinates
          const startLogical = (kzStart - firstVisibleTime) / candleInterval + visibleRange.from;
          const endLogical = (kzEnd - firstVisibleTime) / candleInterval + visibleRange.from;

          const x1 = logicalToCoordinate(startLogical as Logical);
          const x2 = logicalToCoordinate(endLogical as Logical);

          if (x1 === null || x2 === null) continue;

          const width = Math.abs(x2 - x1);
          if (width <= 0) continue;

          // Draw the killzone background
          ctx.fillStyle = kz.color;
          ctx.fillRect(Math.min(x1, x2), 0, width, chartHeight);
        }
      }
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
