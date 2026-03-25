/**
 * Chat Store - AI 对话状态管理
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

  // Actions
  addMessage: (role: 'user' | 'assistant', content: string) => void;
  clearMessages: () => void;
  setOpen: (open: boolean) => void;
  setLoading: (loading: boolean) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      isOpen: false,
      isLoading: false,

      addMessage: (role, content) => {
        const message: ChatMessage = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role,
          content,
          timestamp: Date.now(),
        };
        set({ messages: [...get().messages, message] });
      },

      clearMessages: () => set({ messages: [] }),
      setOpen: (open) => set({ isOpen: open }),
      setLoading: (loading) => set({ isLoading: loading }),
    }),
    {
      name: 'chat-storage',
      partialize: (state) => ({ messages: state.messages }),
    }
  )
);
