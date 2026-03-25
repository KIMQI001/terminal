/**
 * Agent Store - 自主代理状态管理
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
      setLastAnalysis: (analysis) => set({ lastAnalysis: analysis }),
      setDingtalkEnabled: (enabled) => set({ dingtalkEnabled: enabled }),
    }),
    {
      name: 'agent-storage',
    }
  )
);
