/**
 * Chat Store - AI 对话状态管理
 * 每天0点自动清空，也可手动清空
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface ChatState {
  messages: ChatMessage[];
  isOpen: boolean;
  isLoading: boolean;
  lastClearDate: string; // YYYY-MM-DD 格式

  // Actions
  addMessage: (role: 'user' | 'assistant', content: string) => void;
  clearMessages: () => void;
  setOpen: (open: boolean) => void;
  setLoading: (loading: boolean) => void;
  checkAndClearIfNeeded: () => void;
}

const getTodayStr = () => new Date().toISOString().slice(0, 10);

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      isOpen: false,
      isLoading: false,
      lastClearDate: getTodayStr(),

      addMessage: (role, content) => {
        const message: ChatMessage = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role,
          content,
          timestamp: Date.now(),
        };
        set({ messages: [...get().messages, message] });
      },

      clearMessages: () => set({ messages: [], lastClearDate: getTodayStr() }),

      setOpen: (open) => set({ isOpen: open }),
      setLoading: (loading) => set({ isLoading: loading }),

      // 检查是否需要自动清空（跨天后第一次打开）
      checkAndClearIfNeeded: () => {
        const today = getTodayStr();
        if (get().lastClearDate !== today) {
          set({ messages: [], lastClearDate: today });
        }
      },
    }),
    {
      name: 'chat-storage',
      partialize: (state) => ({
        lastClearDate: state.lastClearDate,
        // 不持久化 messages，每次刷新都从空开始
        // 只持久化 lastClearDate 用于判断是否跨天
      }),
    }
  )
);
