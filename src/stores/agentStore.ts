/**
 * Agent Store - 自主代理状态管理
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// 导出 HLLevel 类型
export interface HLLevel {
  price: number;
  time: number;
  type: 'hl' | 'hh' | 'lh' | 'll';
  distance: number; // 与当前价距离 %
  status: 'above' | 'below' | 'approaching' | 'broken';
}

interface AgentState {
  isRunning: boolean;
  lastRunTime: number | null;
  interval: number; // 分钟
  symbols: string[];
  lastAnalysis: string | null;
  dingtalkEnabled: boolean;
  inlineAIEnabled: boolean; // 实时监控开关

  // 实时监控数据
  currentPrice: number | null;
  hlLevels: HLLevel[]; // HL水平线列表

  // Actions
  setRunning: (running: boolean) => void;
  setLastRunTime: (time: number) => void;
  setInterval: (interval: number) => void;
  setSymbols: (symbols: string[]) => void;
  setLastAnalysis: (analysis: string | null) => void;
  setDingtalkEnabled: (enabled: boolean) => void;
  setInlineAIEnabled: (enabled: boolean) => void;
  setCurrentPrice: (price: number) => void;
  setHLLevels: (levels: HLLevel[]) => void;
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
      inlineAIEnabled: true, // 默认开启

      currentPrice: null,
      hlLevels: [],

      setRunning: (running) => set({ isRunning: running }),
      setLastRunTime: (time) => set({ lastRunTime: time }),
      setInterval: (interval) => set({ interval }),
      setSymbols: (symbols) => set({ symbols }),
      setLastAnalysis: (analysis) => set({ lastAnalysis: analysis }),
      setDingtalkEnabled: (enabled) => set({ dingtalkEnabled: enabled }),
      setInlineAIEnabled: (enabled) => set({ inlineAIEnabled: enabled }),
      setCurrentPrice: (price) => set({ currentPrice: price }),
      setHLLevels: (levels) => set({ hlLevels: levels }),
    }),
    {
      name: 'agent-storage',
    }
  )
);
