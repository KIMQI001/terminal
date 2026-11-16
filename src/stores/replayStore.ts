"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Candle } from "@/types/chart";
import { useChartStore } from "./chartStore";
import { useUserStore } from "./userStore";
import {
  createInitialState,
  simulateBar,
  placeOrder as enginePlaceOrder,
  cancelOrder as engineCancelOrder,
  finalizeState,
  resetIdCounter,
  type PlaceOrderInput,
  type PlaceOrderResult,
} from "@/lib/replay/engine";
import { pickReplayWindow } from "@/lib/replay/snapshot";
import { buildScore } from "@/lib/replay/scoring";
import {
  DEFAULT_REPLAY_CONFIG,
  type EquityPoint,
  type ReplayAccount,
  type ReplayConfig,
  type ReplayEngineState,
  type ReplayFill,
  type ReplayOrder,
  type ReplayPosition,
  type ReplayScore,
  type ReplaySessionPayload,
  type ReplayTrade,
} from "@/lib/replay/types";

export type ReplayStatus = "idle" | "running" | "paused" | "review" | "finished";

export interface ReplayPrefill {
  side: "buy" | "sell";
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

/** 当前视图下的账本（回看时按游标截断） */
export interface ReplayView {
  account: ReplayAccount;
  positions: ReplayPosition[];
  orders: ReplayOrder[];
  trades: ReplayTrade[];
  fills: ReplayFill[];
  equityCurve: EquityPoint[];
}

interface ReplayState {
  config: ReplayConfig;

  status: ReplayStatus;
  /** 回放进行中（running / paused / review） */
  isReplaying: boolean;
  symbol: string;
  timeframe: string;

  /** 全量 K 线快照（结束回放时恢复） */
  fullCandles: Candle[];
  /** 回放窗口 */
  bars: Candle[];
  windowStartIndex: number;
  /** 视图游标（图表显示到哪一根） */
  cursor: number;
  /** 真相游标（账本已撮合到哪一根） */
  frontier: number;

  /** 引擎状态（真相） */
  engine: ReplayEngineState;
  /** 当前视图下的账本 */
  view: ReplayView;

  prefill: ReplayPrefill | null;
  /** 模拟下单表单的草稿（用于图上预览 entry/SL/TP 线） */
  draft: { side: "buy" | "sell"; entry?: number; stopLoss?: number; takeProfit?: number } | null;

  result: ReplayScore | null;
  resultPayload: ReplaySessionPayload | null;
  isSaving: boolean;
  saveError: string | null;
  savedId: number | null;
  /** 开始回放失败时的原因（例如 K 线不足） */
  startError: string | null;

  /** 历史存档 */
  history: ReplaySessionRow[];
  stats: ReplayStats | null;
  historyLoading: boolean;

  // ---- Actions ----
  startReplay: (overrides?: Partial<ReplayConfig>) => void;
  stopReplay: () => void;
  endReplay: () => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stepForward: () => void;
  stepBack: () => void;
  jumpToFront: () => void;
  seekTo: (bar: number) => void;
  setSpeed: (n: number) => void;
  setConfig: (patch: Partial<ReplayConfig>) => void;
  setPrefill: (p: ReplayPrefill | null) => void;
  setDraft: (d: ReplayState["draft"]) => void;
  placeSimOrder: (input: PlaceOrderInput) => PlaceOrderResult;
  cancelSimOrder: (id: string) => void;
  closeSimPosition: (positionId: string) => PlaceOrderResult;
  saveSession: () => Promise<boolean>;
  fetchHistory: () => Promise<void>;
}

export interface ReplaySessionRow {
  id: number;
  symbol: string;
  timeframe: string;
  score_total: number;
  grade: string | null;
  net_pnl: number;
  return_pct: number;
  win_rate: number;
  total_trades: number;
  max_drawdown_pct: number;
  created_at: string;
}

export interface ReplayStats {
  overall: {
    sessions: number;
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnl: number;
    avgPnl: number;
    avgScore: number;
    bestScore: number;
    overallWinRate: number;
    avgMaxDrawdownPct: number;
  };
  bySymbol: {
    symbol: string;
    sessions: number;
    totalPnl: number;
    avgScore: number;
    winRate: number;
  }[];
}

// 计时器（不放进 state，避免被 persist 序列化）
let playTimer: ReturnType<typeof setInterval> | null = null;
function stopTimer() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

function emptyView(initialCapital: number): ReplayView {
  return {
    account: {
      initialCapital,
      balance: initialCapital,
      cashFree: initialCapital,
      frozenMargin: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      equity: initialCapital,
      marginUsagePct: 0,
      markPrice: 0,
      maxEquity: initialCapital,
      maxDrawdownPct: 0,
    },
    positions: [],
    orders: [],
    trades: [],
    fills: [],
    equityCurve: [],
  };
}

/** 按游标计算视图账本（回看时截断到那一刻） */
function computeView(engine: ReplayEngineState, bars: Candle[], cursor: number): ReplayView {
  if (cursor >= engine.frontier) {
    return {
      account: { ...engine.account },
      positions: engine.positions.map((p) => ({ ...p })),
      orders: engine.orders.map((o) => ({ ...o })),
      trades: engine.trades.map((t) => ({ ...t })),
      fills: engine.fills.map((f) => ({ ...f })),
      equityCurve: engine.equityCurve.map((e) => ({ ...e })),
    };
  }

  const snap = engine.snapshots[cursor];
  const markPrice = bars[cursor]?.close ?? 0;

  if (!snap) {
    return {
      account: { ...engine.account, markPrice },
      positions: [],
      orders: engine.orders.filter((o) => o.placedAtBar <= cursor).map((o) => ({ ...o })),
      trades: engine.trades.filter((t) => (t.exitBar ?? t.entryBar) <= cursor).map((t) => ({ ...t })),
      fills: engine.fills.filter((f) => f.bar <= cursor).map((f) => ({ ...f })),
      equityCurve: engine.equityCurve.filter((e) => e.bar <= cursor).map((e) => ({ ...e })),
    };
  }

  const account: ReplayAccount = {
    initialCapital: engine.account.initialCapital,
    balance: snap.balance,
    cashFree: snap.balance - snap.frozenMargin,
    frozenMargin: snap.frozenMargin,
    realizedPnl: snap.realizedPnl,
    unrealizedPnl: snap.unrealizedPnl,
    equity: snap.equity,
    marginUsagePct: snap.equity > 0 ? (snap.frozenMargin / snap.equity) * 100 : 0,
    markPrice,
    maxEquity: snap.maxEquity,
    maxDrawdownPct: snap.maxDrawdownPct,
  };

  return {
    account,
    positions: snap.positions.map((p) => ({ ...p })),
    orders: engine.orders.filter((o) => o.placedAtBar <= cursor).map((o) => ({ ...o })),
    trades: engine.trades.filter((t) => (t.exitBar ?? t.entryBar) <= cursor).map((t) => ({ ...t })),
    fills: engine.fills.filter((f) => f.bar <= cursor).map((f) => ({ ...f })),
    equityCurve: engine.equityCurve.filter((e) => e.bar <= cursor).map((e) => ({ ...e })),
  };
}

/** 把图表裁剪到「窗口起点 + 游标」 */
function applyVisible(fullCandles: Candle[], windowStartIndex: number, cursor: number) {
  const chart = useChartStore.getState();
  const end = Math.max(0, Math.min(fullCandles.length, windowStartIndex + cursor + 1));
  chart.setCandles(fullCandles.slice(0, end));
  chart.bumpSeriesVersion();
}

function restoreFull(fullCandles: Candle[]) {
  const chart = useChartStore.getState();
  chart.setCandles(fullCandles);
  chart.bumpSeriesVersion();
}

export const useReplayStore = create<ReplayState>()(
  persist(
    (set, get) => ({
      config: {
        ...DEFAULT_REPLAY_CONFIG,
        symbol: "BTCUSDC",
        timeframe: "15m",
      },

      status: "idle",
      isReplaying: false,
      symbol: "BTCUSDC",
      timeframe: "15m",

      fullCandles: [],
      bars: [],
      windowStartIndex: 0,
      cursor: -1,
      frontier: -1,

      engine: createInitialState({ ...DEFAULT_REPLAY_CONFIG, symbol: "BTCUSDC", timeframe: "15m" }),
      view: emptyView(DEFAULT_REPLAY_CONFIG.initialCapital),

      prefill: null,
      draft: null,

      result: null,
      resultPayload: null,
      isSaving: false,
      saveError: null,
      savedId: null,
      startError: null,

      history: [],
      stats: null,
      historyLoading: false,

      // ---------------------------------------------------------------
      startReplay: (overrides) => {
        stopTimer();
        const chart = useChartStore.getState();
        const symbol = chart.symbol;
        const timeframe = chart.timeframe;
        const config: ReplayConfig = {
          ...get().config,
          ...overrides,
          symbol,
          timeframe,
        };

        const win = pickReplayWindow(chart.candles, timeframe, config.barCount);
        if (win.bars.length < 5) {
          // K 线不足，无法开始
          set({
            config,
            startError: `可用 K 线不足（只有 ${win.bars.length} 根已收盘），请等待行情加载或减少回放根数`,
          });
          return;
        }

        resetIdCounter();
        const engine = createInitialState(config);

        set({
          config,
          status: "paused",
          isReplaying: true,
          symbol,
          timeframe,
          fullCandles: win.fullCandles,
          bars: win.bars,
          windowStartIndex: win.windowStartIndex,
          cursor: 0,
          frontier: -1,
          engine,
          view: computeView(engine, win.bars, 0),
          prefill: null,
          draft: null,
          result: null,
          resultPayload: null,
          isSaving: false,
          saveError: null,
          savedId: null,
          startError: null,
        });

        applyVisible(win.fullCandles, win.windowStartIndex, 0);
      },

      stopReplay: () => {
        stopTimer();
        const { fullCandles } = get();
        set({
          status: "idle",
          isReplaying: false,
          cursor: -1,
          frontier: -1,
          engine: createInitialState(get().config),
          view: emptyView(get().config.initialCapital),
          prefill: null,
          draft: null,
          result: null,
          resultPayload: null,
          isSaving: false,
          saveError: null,
          savedId: null,
        });
        restoreFull(fullCandles);
      },

      endReplay: () => {
        stopTimer();
        const { engine, bars, config, fullCandles, symbol, timeframe, frontier } = get();
        const lastIndex = bars.length > 0 ? bars.length - 1 : 0;
        const settleIndex = Math.max(frontier, 0);
        const price = bars[settleIndex]?.close ?? bars[lastIndex]?.close ?? 0;
        const time = bars[settleIndex]?.time ?? 0;

        const finalEngine = finalizeState(engine, price, settleIndex, time);
        const score = buildScore(finalEngine.trades, finalEngine.account, config, bars, finalEngine.orders);

        const payload: ReplaySessionPayload = {
          symbol,
          timeframe,
          barCount: config.barCount,
          barsReplayed: settleIndex + 1,
          config: { ...config, symbol, timeframe },
          startedAt: bars[0]?.time ?? 0,
          endedAt: time,
          account: finalEngine.account,
          score,
          trades: finalEngine.trades,
          equityCurve: finalEngine.equityCurve,
        };

        set({
          status: "finished",
          isReplaying: false,
          cursor: settleIndex,
          frontier: settleIndex,
          engine: finalEngine,
          view: computeView(finalEngine, bars, settleIndex),
          result: score,
          resultPayload: payload,
          prefill: null,
        });

        restoreFull(fullCandles);
        void get().saveSession();
      },

      play: () => {
        const { status } = get();
        const { speed } = get().config;
        if (status !== "paused" && status !== "running") return;
        stopTimer();
        set({ status: "running" });
        const interval = Math.max(120, 1000 / Math.max(0.5, speed));
        playTimer = setInterval(() => {
          const s = get();
          if (s.frontier + 1 >= s.bars.length) {
            stopTimer();
            set({ status: "paused" });
            return;
          }
          s.stepForward();
        }, interval);
      },

      pause: () => {
        stopTimer();
        if (get().status === "running") set({ status: "paused" });
      },

      togglePlay: () => {
        const { status } = get();
        if (status === "running") get().pause();
        else get().play();
      },

      stepForward: () => {
        const { engine, bars, config, frontier, status } = get();
        if (!get().isReplaying) return;
        if (frontier + 1 >= bars.length) return;

        const nextIndex = frontier + 1;
        const nextEngine = simulateBar(engine, bars[nextIndex], nextIndex, config);
        const nextCursor = nextIndex;

        set({
          engine: nextEngine,
          frontier: nextIndex,
          cursor: nextCursor,
          view: computeView(nextEngine, bars, nextCursor),
          status: status === "running" ? "running" : status === "review" ? "review" : "paused",
        });
        applyVisible(get().fullCandles, get().windowStartIndex, nextCursor);
      },

      stepBack: () => {
        const { cursor, frontier } = get();
        if (!get().isReplaying) return;
        const next = Math.max(-1, cursor - 1);
        set({
          cursor: next,
          view: computeView(get().engine, get().bars, next),
          status: next < frontier ? "review" : "paused",
        });
        applyVisible(get().fullCandles, get().windowStartIndex, next);
      },

      jumpToFront: () => {
        const { frontier, engine, bars } = get();
        if (!get().isReplaying) return;
        set({
          cursor: frontier,
          view: computeView(engine, bars, frontier),
          status: "paused",
        });
        applyVisible(get().fullCandles, get().windowStartIndex, frontier);
      },

      seekTo: (bar) => {
        const { frontier, engine, bars } = get();
        if (!get().isReplaying) return;
        const next = Math.max(-1, Math.min(frontier, bar));
        set({
          cursor: next,
          view: computeView(engine, bars, next),
          status: next < frontier ? "review" : "paused",
        });
        applyVisible(get().fullCandles, get().windowStartIndex, next);
      },

      setSpeed: (n) => {
        const speed = Math.max(0.5, Math.min(8, n));
        set({ config: { ...get().config, speed } });
        if (get().status === "running") {
          stopTimer();
          get().play();
        }
      },

      setConfig: (patch) => set({ config: { ...get().config, ...patch } }),

      setPrefill: (p) => set({ prefill: p }),

      setDraft: (d) => set({ draft: d }),

      placeSimOrder: (input) => {
        const { isReplaying, status, cursor, frontier, engine, config, bars } = get();
        if (!isReplaying) return { ok: false, error: "当前不在回放模式" };
        if (status === "review" || cursor < frontier) {
          return { ok: false, error: "回看模式：请先点「跳到最新」再下单" };
        }
        const currentPrice = bars[cursor]?.close ?? 0;
        if (!(currentPrice > 0)) return { ok: false, error: "当前没有可用的价格" };

        const nextEngine: ReplayEngineState = {
          ...engine,
          orders: engine.orders.map((o) => ({ ...o })),
          positions: engine.positions.map((p) => ({ ...p })),
        };
        const result = enginePlaceOrder(nextEngine, input, config, cursor, currentPrice);
        if (!result.ok) return result;

        set({
          engine: nextEngine,
          view: computeView(nextEngine, bars, cursor),
        });
        return result;
      },

      cancelSimOrder: (id) => {
        const { engine, bars, cursor, frontier } = get();
        if (!get().isReplaying) return;
        if (cursor < frontier) return;
        const nextEngine: ReplayEngineState = {
          ...engine,
          orders: engine.orders.map((o) => ({ ...o })),
        };
        engineCancelOrder(nextEngine, id, cursor, "manual");
        set({ engine: nextEngine, view: computeView(nextEngine, bars, cursor) });
      },

      closeSimPosition: (positionId) => {
        const { isReplaying, status, cursor, frontier, engine, config, bars } = get();
        if (!isReplaying) return { ok: false, error: "当前不在回放模式" };
        if (status === "review" || cursor < frontier) {
          return { ok: false, error: "回看模式：请先点「跳到最新」再平仓" };
        }
        const currentPrice = bars[cursor]?.close ?? 0;
        const nextEngine: ReplayEngineState = {
          ...engine,
          orders: engine.orders.map((o) => ({ ...o })),
          positions: engine.positions.map((p) => ({ ...p })),
        };
        const result = enginePlaceOrder(
          nextEngine,
          { side: "buy", type: "market", quantity: 0, reduceOnly: true, positionId },
          config,
          cursor,
          currentPrice
        );
        if (!result.ok) return result;
        set({ engine: nextEngine, view: computeView(nextEngine, bars, cursor) });
        return result;
      },

      saveSession: async () => {
        const token = useUserStore.getState().token;
        const payload = get().resultPayload;
        if (!token || !payload) {
          set({ saveError: "未登录或没有可保存的成绩" });
          return false;
        }
        set({ isSaving: true, saveError: null });
        try {
          const res = await fetch("/api/user/replay/sessions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
          });
          const json = await res.json();
          if (res.ok && json.success) {
            set({ isSaving: false, savedId: json.id });
            void get().fetchHistory();
            return true;
          }
          set({ isSaving: false, saveError: json.error || "保存失败" });
          return false;
        } catch (e) {
          set({ isSaving: false, saveError: e instanceof Error ? e.message : "保存失败" });
          return false;
        }
      },

      fetchHistory: async () => {
        const token = useUserStore.getState().token;
        if (!token) return;
        set({ historyLoading: true });
        try {
          const [listRes, statsRes] = await Promise.all([
            fetch("/api/user/replay/sessions?limit=50", { headers: { Authorization: `Bearer ${token}` } }),
            fetch("/api/user/replay/stats", { headers: { Authorization: `Bearer ${token}` } }),
          ]);
          const listJson = await listRes.json();
          const statsJson = await statsRes.json();
          set({
            history: Array.isArray(listJson.sessions) ? listJson.sessions : [],
            stats: statsJson?.stats ?? null,
            historyLoading: false,
          });
        } catch {
          set({ historyLoading: false });
        }
      },
    }),
    {
      name: "replay-settings",
      partialize: (state) => ({
        config: state.config,
      }),
    }
  )
);

// 开发模式下暴露到 window，方便端到端脚本断言
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__replayStore = useReplayStore;
}
