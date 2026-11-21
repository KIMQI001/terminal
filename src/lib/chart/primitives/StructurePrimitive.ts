/**
 * 市场结构 Primitive for Lightweight Charts v4
 *
 * 画出市场结构层的三样东西：
 * - **Swing legs**：相邻两个摆动点之间的连线（涨=绿、跌=红）
 * - **BOS**：Break of Structure —— 顺势突破结构位（蓝色虚线=向上突破 / 红色虚线=向下突破）
 * - **CHoCH**：Change of Character —— 逆势突破结构位（绿色虚线=向上 / 紫色虚线=向下）
 * - **目标位**：下一个 BOS / CHoCH 的**目标价** —— **实线**（门槛位外侧的下一个结构位，
 *   也就是「LL 底下的目标」「HH 上方的目标」），从该结构位一路画到图表右缘。
 *   目标位被**收盘**越过 → 它从候选里消失 → 实线自动外推到更远的目标；
 *   同时门槛位被越过时，引擎会真的报出 BOS / CHoCH → 虚线事件线。
 *
 * ## 为什么用 Primitive 而不是 SVG 覆盖层
 *
 * 之前的实现用一个 absolute 定位的 <svg> 叠在图表上，用 series.priceToCoordinate()
 * 算 y 坐标。问题是：
 * 1. **坐标会过期**。价格轴是 autoScale 的，K 线刷新 / 缩放 / 滚动之后价格区间会重算，
 *    但 SVG 只在 React 的 effect 里更新一次，于是画出来的线停在旧价格区间上（y 可能是 -2976），
 *    整条线飞到屏幕外。
 * 2. **原点对不齐**。SVG 的左上角是页面/容器左上角，图表 pane 却在左边价格轴右侧（差 78px），
 *    x 坐标整体偏移。
 *
 * Primitive 走 lightweight-charts 自己的绘制管线：每次重绘都会调用 updateAllViews()，
 * 拿到的是**当前**的价格轴与时间轴坐标，画出来一定跟 K 线对齐。
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

/** 一条结构事件（BOS / CHoCH） */
export interface StructureEvent {
  /** "bos" = 顺势突破，"choch" = 逆势突破（趋势可能反转） */
  kind: "bos" | "choch";
  /** 突破方向："bullish" = 收盘向上越过结构位，"bearish" = 收盘向下越过结构位 */
  direction: "bullish" | "bearish";
  /** 被突破的结构位价格 —— 线就画在这个价位上 */
  level: number;
  /** 突破那根 K 的时间 */
  breakTime: number;
  /** 被破结构位所在的摆动点时间（线的起点） */
  swingTime: number;
}

/**
 * 一条**预测**的结构事件 —— 还没发生，价格一旦触及就会变成真的 BOS / CHoCH
 *
 * 画成实线；真发生了就由对应的 StructureEvent 接手（虚线）。
 */
export interface StructurePredictionEvent {
  /** "bos" = 顺势突破，"choch" = 逆势突破 */
  kind: "bos" | "choch";
  /** 方向："bullish" = 上方目标，"bearish" = 下方目标 */
  direction: "bullish" | "bearish";
  /** 目标结构位价格 */
  level: number;
  /** 目标结构位所在的摆动点时间（线的起点） */
  swingTime: number;
}

/** 一条 swing leg（相邻两个摆动点的连线） */
export interface SwingLeg {
  /** 起点摆动点的时间 */
  time1: number;
  /** 起点摆动点的价格 */
  price1: number;
  /** 终点摆动点的时间 */
  time2: number;
  /** 终点摆动点的价格 */
  price2: number;
  /** "up" = 涨段（绿），"down" = 跌段（红） */
  direction: "up" | "down";
}

interface StructureRendererData {
  events: StructureEvent[];
  /** 预测位（实线） */
  predictions: StructurePredictionEvent[];
  legs: SwingLeg[];
  priceToCoordinate: (price: number) => Coordinate | null;
  timeToCoordinate: (time: Time) => Coordinate | null;
  chartWidth: number;
  /** 一根 bar 的像素宽度，用来按缩放比例延伸突破线 */
  barSpacing: number;
}

/** BOS 配色：向上突破=蓝，向下突破=红（虚线） */
const BOS_BULLISH = "#3b82f6";
const BOS_BEARISH = "#ef4444";
/** CHoCH 配色：向上=绿，向下=紫（虚线） */
const CHOCH_BULLISH = "#22c55e";
const CHOCH_BEARISH = "#a855f7";
/** swing leg 配色 */
const LEG_UP = "#22c55e";
const LEG_DOWN = "#ef4444";

const LABEL_WIDTH = 32;
const LABEL_HEIGHT = 13;

/** 结构事件的配色：BOS 向上=蓝 / 向下=红，CHoCH 向上=绿 / 向下=紫 */
function structureColor(kind: "bos" | "choch", direction: "bullish" | "bearish"): string {
  const isBullish = direction === "bullish";
  if (kind === "bos") return isBullish ? BOS_BULLISH : BOS_BEARISH;
  return isBullish ? CHOCH_BULLISH : CHOCH_BEARISH;
}

/**
 * 同一类事件最多画几个文字标签。
 *
 * 结构线本身可以全画（一条水平线信息量不大，密一点还能看出结构带），
 * 但 "BOS" / "CHoCH" 文字标签如果全画，缩放到全景时会糊成一片、完全读不了。
 * 所以：线全画，标签只给**最近的 N 个**。
 */
const MAX_BOS_LABELS = 12;
const MAX_CHOCH_LABELS = 12;

/**
 * 可视区里同一类事件最多画多少条线。
 * 缩放到全景时可能有几百个结构事件全挤在一屏，只画最近的一批。
 */
const MAX_BOS_LINES = 60;
const MAX_CHOCH_LINES = 20;

class StructurePaneRenderer implements ISeriesPrimitivePaneRenderer {
  private _data: StructureRendererData | null = null;

  update(data: StructureRendererData): void {
    this._data = data;
  }

  draw(target: CanvasRenderingTarget2D): void {
    if (!this._data) return;
    const { events, predictions, legs, priceToCoordinate, timeToCoordinate, chartWidth, barSpacing } = this._data;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      // ── Swing legs（画在最底层）────────────────────────
      // 只画可视区内的 leg —— 历史数据可能有几千段，全画会把图糊死
      ctx.lineWidth = 2;
      for (const leg of legs) {
        const x1 = timeToCoordinate(leg.time1 as Time);
        const y1 = priceToCoordinate(leg.price1);
        const x2 = timeToCoordinate(leg.time2 as Time);
        const y2 = priceToCoordinate(leg.price2);
        if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
        // leg 的水平跨度必须在可视区里
        const lo = Math.min(x1, x2);
        const hi = Math.max(x1, x2);
        if (hi < 0 || lo > chartWidth) continue;

        ctx.strokeStyle = leg.direction === "up" ? LEG_UP : LEG_DOWN;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // ── 预测位（实线，延伸到图表右缘）────────────────
      // 下一个 BOS / CHoCH 的目标价（门槛外侧的下一个结构位）。
      // 目标价被收盘越过 → 它从候选里消失 → 这条实线自动外推到更远的目标。
      for (const p of predictions) {
        const y = priceToCoordinate(p.level);
        if (y === null) continue;
        if (y < -8 || y > mediaSize.height + 8) continue;

        const xStartRaw = timeToCoordinate(p.swingTime as Time);
        const xStart = xStartRaw === null ? 0 : Math.max(0, xStartRaw);

        const color = structureColor(p.kind, p.direction);

        // 实线（与已发生事件的虚线区分开）
        ctx.strokeStyle = color;
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(xStart, y);
        ctx.lineTo(chartWidth, y);
        ctx.stroke();

        // 右端标签：目标BOS / 目标CHoCH
        // 标签放在**线的上方**而不是压在线上 —— 上方目标的摆动点往往很靠右，
        // 线本身只有几十像素宽，标签压上去会把线整段盖掉。
        const text = p.kind === "bos" ? "目标BOS" : "目标CHoCH";
        ctx.font = "11px sans-serif";
        const tw = ctx.measureText(text).width + 12;
        const th = 15;
        const lx = Math.max(0, chartWidth - tw - 3);
        const ly = y - th - 4;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.92;
        ctx.fillRect(lx, ly, tw, th);
        ctx.globalAlpha = 1;

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, lx + tw / 2, ly + th / 2);
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);

      // ── BOS / CHoCH 结构线 ────────────────────────────
      // 先算出每条事件的几何信息，再按可视区 + 数量上限过滤，最后统一绘制
      type Drawn = {
        ev: StructureEvent;
        y: number;
        xBreak: number;
        xStart: number;
        xEnd: number;
        color: string;
        isBOS: boolean;
      };

      const drawn: Drawn[] = [];
      for (const ev of events) {
        const y = priceToCoordinate(ev.level);
        if (y === null) continue;

        const xBreak = timeToCoordinate(ev.breakTime as Time);
        if (xBreak === null) continue;

        // 突破点在可视区外（左右都离得远）→ 不画
        if (xBreak < -barSpacing * 4 || xBreak > chartWidth + barSpacing * 4) continue;

        // 起点 = 被破结构位所在那根 K；拿不到时退化成「突破点往左若干根 K」
        const xStartRaw = timeToCoordinate(ev.swingTime as Time);
        const fallbackX = Math.max(0, xBreak - barSpacing * 10);
        const xStart = xStartRaw === null ? fallbackX : Math.min(xStartRaw, xBreak);

        const isBOS = ev.kind === "bos";
        const color = structureColor(ev.kind, ev.direction);

        // 线：水平，画在结构位上，从被破处延伸到突破点再往后一小段
        const extendPx = barSpacing * 2;
        const xEnd = Math.min(xBreak + extendPx, chartWidth);

        drawn.push({ ev, y, xBreak, xStart, xEnd, color, isBOS });
      }

      // 数量上限：同类只保留**最近**的一批（events 按时间升序，尾部 = 最新）
      const bosDrawn = drawn.filter((d) => d.isBOS);
      const chochDrawn = drawn.filter((d) => !d.isBOS);
      const keepBos = new Set(bosDrawn.slice(-MAX_BOS_LINES));
      const keepChoch = new Set(chochDrawn.slice(-MAX_CHOCH_LINES));
      const visible = drawn.filter((d) => (d.isBOS ? keepBos.has(d) : keepChoch.has(d)));

      // 标签名额：同类里最近的 N 个才有文字标签
      const bosWithLabel = new Set(bosDrawn.slice(-MAX_BOS_LABELS));
      const chochWithLabel = new Set(chochDrawn.slice(-MAX_CHOCH_LABELS));

      for (const d of visible) {
        ctx.strokeStyle = d.color;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = d.isBOS ? 1 : 1.5;
        // 已发生的事件一律虚线；实线留给「预测位」
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(d.xStart, d.y);
        ctx.lineTo(d.xEnd, d.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // 突破点小圆点 —— 落在真正的突破位置上
        ctx.fillStyle = d.color;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(d.xBreak, d.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // 标签：BOS / CHoCH，贴在突破点附近
        const hasLabel = d.isBOS ? bosWithLabel.has(d) : chochWithLabel.has(d);
        if (!hasLabel) continue;

        const label = d.isBOS ? "BOS" : "CHoCH";
        const labelX = Math.min(
          Math.max(0, d.xBreak - LABEL_WIDTH),
          Math.max(0, chartWidth - LABEL_WIDTH),
        );
        ctx.fillStyle = d.color;
        ctx.globalAlpha = 0.9;
        ctx.fillRect(labelX, d.y - LABEL_HEIGHT / 2, LABEL_WIDTH, LABEL_HEIGHT);
        ctx.globalAlpha = 1;

        ctx.fillStyle = "#ffffff";
        ctx.font = "10px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, labelX + LABEL_WIDTH / 2, d.y);
      }
    });
  }
}

class StructurePaneView implements ISeriesPrimitivePaneView {
  private _renderer: StructurePaneRenderer;
  private _data: StructureRendererData | null = null;

  constructor() {
    this._renderer = new StructurePaneRenderer();
  }

  update(data: StructureRendererData): void {
    this._data = data;
    this._renderer.update(data);
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    // 底层 —— 不遮挡 K 线
    return "bottom";
  }
}

export class StructurePrimitive implements ISeriesPrimitive<Time> {
  private _paneView: StructurePaneView;
  private _events: StructureEvent[] = [];
  private _predictions: StructurePredictionEvent[] = [];
  private _legs: SwingLeg[] = [];
  private _chart: IChartApiBase<Time> | null = null;
  private _series: SeriesAttachedParameter<Time>["series"] | null = null;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new StructurePaneView();
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

    const data: StructureRendererData = {
      events: this._events,
      predictions: this._predictions,
      legs: this._legs,
      priceToCoordinate: (price: number) => this._series!.priceToCoordinate(price),
      timeToCoordinate: (time: Time) => timeScale.timeToCoordinate(time),
      chartWidth: timeScale.width(),
      barSpacing: timeScale.options().barSpacing || 6,
    };

    this._paneView.update(data);
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this._paneView];
  }

  /** 更新要画的 BOS / CHoCH */
  setEvents(events: StructureEvent[]): void {
    this._events = events;
    if (this._requestUpdate) this._requestUpdate();
  }

  /** 更新要画的预测位（实线） */
  setPredictions(predictions: StructurePredictionEvent[]): void {
    this._predictions = predictions;
    if (this._requestUpdate) this._requestUpdate();
  }

  /** 更新要画的 swing legs */
  setLegs(legs: SwingLeg[]): void {
    this._legs = legs;
    if (this._requestUpdate) this._requestUpdate();
  }

  getEvents(): StructureEvent[] {
    return this._events;
  }
}
