/**
 * Analysis Service API Client
 */

const API_BASE =
  process.env.NEXT_PUBLIC_ANALYSIS_API || "http://127.0.0.1:3002";

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
    `${API_BASE}/api/signals?status=${status}&days=${days}`
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
  return fetchApi<Signal>(`/api/signals/${id}`);
}

/**
 * 获取信号统计
 */
export async function fetchSignalStats(days: number = 30): Promise<SignalStats> {
  return fetchApi<SignalStats>(`/api/signals/stats?days=${days}`);
}

/**
 * 获取绩效统计
 */
export async function fetchPerformanceStats(
  days: number = 30
): Promise<PerformanceStats> {
  return fetchApi<PerformanceStats>(`/api/performance/stats?days=${days}`);
}

/**
 * 获取收益曲线
 */
export async function fetchEquityCurve(
  days: number = 30
): Promise<EquityPoint[]> {
  return fetchApi<EquityPoint[]>(`/api/performance/equity-curve?days=${days}`);
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
  return fetchApi(`/api/performance/overview`);
}

/**
 * 健康检查
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const json = await res.json();
    return json.success === true;
  } catch {
    return false;
  }
}
