/**
 * Agent Store - 自主代理状态管理
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// 导出 HLLevel 类型
export interface HLLevel {
  price: number;
  time: number;
  type: 'hh' | 'hl' | 'lh' | 'll';
  timeframe: string; // 周期
  distance: number; // 与当前价距离 %
  status: 'above' | 'below' | 'approaching' | 'broken';
  category: 'resistance' | 'support'; // 压力位还是支撑位
}

interface AgentState {
  isRunning: boolean;
  lastRunTime: number | null;
  interval: number; // 分钟
  symbols: string[];
  lastAnalysis: string | null;
  dingtalkEnabled: boolean;

  // Actions
  setRunning: (running: boolean) => void;
  setLastRunTime: (time: number) => void;
  setInterval: (interval: number) => void;
  setSymbols: (symbols: string[]) => void;
  setLastAnalysis: (analysis: string | null) => void;
  setDingtalkEnabled: (enabled: boolean) => void;
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      isRunning: false,
      lastRunTime: null,
      interval: 15,
      symbols: ['BTC'],
      lastAnalysis: null,
      dingtalkEnabled: true,

      setRunning: (running) => set({ isRunning: running }),
      setLastRunTime: (time) => set({ lastRunTime: time }),
      setInterval: (interval) => set({ interval }),
      setSymbols: (symbols) => set({ symbols }),
      setLastAnalysis: (analysis: string | null) => set({ lastAnalysis: analysis }),
      setDingtalkEnabled: (enabled) => set({ dingtalkEnabled: enabled }),
    }),
    {
      name: 'agent-storage',
    }
  )
);
