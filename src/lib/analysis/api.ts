/**
 * Analysis Service API Client
 * 通过 Next.js API 路由代理访问 analysis-service
 */

const API_BASE = "/api/analysis";

/** 信号记录类型 */
export interface Signal {
  id: string;
  createdAt: string;
  symbol: string;
  timeframe: string;
  direction: "long" | "short";
  confidence: "high" | "medium" | "low";
  entryPrice: number;
  stopLoss: number;
  takeProfits: number[];
  riskReward: number;
  reasoning: string | null;
  status: "pending" | "entered" | "stopped" | "profit" | "expired";
  enteredAt: string | null;
  exitedAt: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  actualRR: number | null;
  pnlPercent: number | null;
}

/** 绩效统计类型 */
export interface PerformanceStats {
  totalSignals: number;
  enteredSignals: number;
  completedSignals: number;
  pendingSignals: number;
  expiredSignals: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWinRR: number;
  avgLossRR: number;
  avgRR: number;
  profitFactor: number;
  expectancy: number;
  totalPnlPercent: number;
  avgWinPercent: number;
  avgLossPercent: number;
  byTimeframe: Record<
    string,
    {
      signals: number;
      winCount: number;
      lossCount: number;
      winRate: number;
      avgRR: number;
    }
  >;
  byDirection: Record<
    string,
    {
      signals: number;
      winCount: number;
      lossCount: number;
      winRate: number;
      avgRR: number;
    }
  >;
}

/** 收益曲线点 */
export interface EquityPoint {
  time: number;
  value: number;
  pnl: number;
  symbol: string;
  timeframe: string;
}

/** 信号统计 */
export interface SignalStats {
  total: number;
  pending: number;
  entered: number;
  stopped: number;
  profit: number;
  expired: number;
}

/** API 响应类型 */
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  count?: number;
}

/**
 * 通用 fetch 封装
 */
async function fetchApi<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`);
  const json: ApiResponse<T> = await res.json();

  if (!json.success || !json.data) {
    throw new Error(json.error || "API request failed");
  }

  return json.data;
}

/**
 * 获取信号列表
 */
export async function fetchSignals(
  status: "all" | "pending" | "entered" | "completed" = "all",
  days: number = 30
): Promise<Signal[]> {
  const res = await fetch(
    `${API_BASE}/signals?status=${status}&days=${days}`
  );
  const json: ApiResponse<Signal[]> = await res.json();

  if (!json.success) {
    throw new Error(json.error || "Failed to fetch signals");
  }

  return json.data || [];
}

/**
 * 获取单个信号详情
 */
export async function fetchSignalById(id: string): Promise<Signal> {
  return fetchApi<Signal>(`/signals/${id}`);
}

/**
 * 获取信号统计
 */
export async function fetchSignalStats(days: number = 30): Promise<SignalStats> {
  return fetchApi<SignalStats>(`/signals/stats?days=${days}`);
}

/**
 * 获取绩效统计
 */
export async function fetchPerformanceStats(
  days: number = 30
): Promise<PerformanceStats> {
  return fetchApi<PerformanceStats>(`/performance/stats?days=${days}`);
}

/**
 * 获取收益曲线
 */
export async function fetchEquityCurve(
  days: number = 30
): Promise<EquityPoint[]> {
  return fetchApi<EquityPoint[]>(`/performance/equity-curve?days=${days}`);
}

/**
 * 获取概览统计
 */
export async function fetchOverview(): Promise<{
  weekly: {
    totalSignals: number;
    completedSignals: number;
    winRate: number;
    avgRR: number;
    expectancy: number;
    totalPnlPercent: number;
  };
  allTime: {
    totalSignals: number;
    completedSignals: number;
    winRate: number;
    avgRR: number;
    expectancy: number;
    totalPnlPercent: number;
  };
}> {
  return fetchApi(`/performance/overview`);
}

/**
 * 健康检查
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    const json = await res.json();
    return json.success === true;
  } catch {
    return false;
  }
}

/** AI 分析结果类型 */
export interface AnalyzeResult {
  symbol: string;
  timeframe: string;
  currentPrice: number;
  trend: "bullish" | "bearish" | "neutral";
  signal: {
    direction: "long" | "short" | "neutral";
    confidence: "high" | "medium" | "low";
    entry: { price: number; zone: string };
    stopLoss: { price: number; reason: string };
    takeProfit: Array<{ price: number; reason: string }>;
    riskReward: number;
    reasoning: string;
    warnings: string[];
  };
  ict: {
    swingPoints: Array<{ type: string; price: number }>;
    fvgs: Array<{ type: string; high: number; low: number }>;
    oteZones: Array<{ type: string; fib618: number; fib786: number }>;
    bos: Array<{ type: string; level: number }>;
    choch: Array<{ type: string; level: number }>;
  };
  timestamp: string;
}

/** AI 调用状态 */
export interface AnalyzeStatus {
  canCall: boolean;
  reason: string | null;
  hourlyUsed: number;
  dailyUsed: number;
  timeframes: string[];
}

/**
 * 手动触发 AI 分析
 */
export async function triggerAnalyze(
  symbol: string = "BTCUSDC",
  timeframe: string
): Promise<AnalyzeResult> {
  const res = await fetch(`${API_BASE}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, timeframe }),
  });
  const json: ApiResponse<AnalyzeResult> = await res.json();

  if (!json.success || !json.data) {
    throw new Error(json.error || "AI 分析失败");
  }

  return json.data;
}

/**
 * 获取 AI 调用状态
 */
export async function fetchAnalyzeStatus(): Promise<AnalyzeStatus> {
  return fetchApi<AnalyzeStatus>("/analyze/status");
}
