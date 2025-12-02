import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, ApiConfigDisplay, ExchangeType, AuthResponse, SaveApiConfigRequest, TestConnectionResponse } from '@/types/user';

interface UserState {
  // 用户信息
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;

  // API 配置
  apiConfigs: ApiConfigDisplay[];
  activeExchange: ExchangeType | null;

  // 加载状态
  loading: boolean;
  error: string | null;

  // 设置模态框
  isSettingsOpen: boolean;

  // Actions
  login: (username: string, password: string) => Promise<boolean>;
  register: (username: string, password: string, inviteCode: string) => Promise<boolean>;
  logout: () => void;
  changePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;

  fetchApiConfigs: () => Promise<void>;
  saveApiConfig: (config: SaveApiConfigRequest) => Promise<boolean>;
  deleteApiConfig: (exchange: ExchangeType) => Promise<boolean>;
  testConnection: (exchange: ExchangeType) => Promise<TestConnectionResponse>;

  setActiveExchange: (exchange: ExchangeType | null) => void;
  openSettings: () => void;
  closeSettings: () => void;
  clearError: () => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      apiConfigs: [],
      activeExchange: null,
      loading: false,
      error: null,
      isSettingsOpen: false,

      // 登录
      login: async (username: string, password: string) => {
        set({ loading: true, error: null });
        try {
          const response = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, action: 'login' }),
          });

          const data: AuthResponse = await response.json();

          if (data.success && data.token && data.user) {
            set({
              user: data.user,
              token: data.token,
              isAuthenticated: true,
              loading: false,
            });
            // 登录后获取 API 配置
            get().fetchApiConfigs();
            return true;
          } else {
            set({ error: data.error || '登录失败', loading: false });
            return false;
          }
        } catch {
          set({ error: '网络错误', loading: false });
          return false;
        }
      },

      // 注册
      register: async (username: string, password: string, inviteCode: string) => {
        set({ loading: true, error: null });
        try {
          const response = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, inviteCode, action: 'register' }),
          });

          const data: AuthResponse = await response.json();

          if (data.success && data.token && data.user) {
            set({
              user: data.user,
              token: data.token,
              isAuthenticated: true,
              loading: false,
            });
            return true;
          } else {
            set({ error: data.error || '注册失败', loading: false });
            return false;
          }
        } catch {
          set({ error: '网络错误', loading: false });
          return false;
        }
      },

      // 修改密码
      changePassword: async (oldPassword: string, newPassword: string) => {
        const { token } = get();
        if (!token) return false;

        set({ loading: true, error: null });
        try {
          const response = await fetch('/api/user/password', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ oldPassword, newPassword }),
          });

          const data = await response.json();

          if (response.ok) {
            set({ loading: false });
            return true;
          } else {
            set({ error: data.error || '修改密码失败', loading: false });
            return false;
          }
        } catch {
          set({ error: '网络错误', loading: false });
          return false;
        }
      },

      // 登出
      logout: () => {
        // 先关闭设置模态框
        set({ isSettingsOpen: false });

        // 清除 localStorage 中的持久化状态
        if (typeof window !== 'undefined') {
          localStorage.removeItem('user-storage');
        }

        // 清除内存中的状态
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          apiConfigs: [],
          activeExchange: null,
        });

        // 最后跳转到登录页（整页刷新避免图表错误）
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
      },

      // 获取 API 配置列表
      fetchApiConfigs: async () => {
        const { token } = get();
        if (!token) return;

        try {
          const response = await fetch('/api/user/api-config', {
            headers: { Authorization: `Bearer ${token}` },
          });

          if (response.ok) {
            const data = await response.json();
            set({ apiConfigs: data.configs });

            // 如果有 Binance 配置，设为默认激活
            const binanceConfig = data.configs.find((c: ApiConfigDisplay) => c.exchange === 'binance');
            if (binanceConfig && !get().activeExchange) {
              set({ activeExchange: 'binance' });
            }
          }
        } catch (error) {
          console.error('Failed to fetch API configs:', error);
        }
      },

      // 保存 API 配置
      saveApiConfig: async (config: SaveApiConfigRequest) => {
        const { token } = get();
        if (!token) return false;

        set({ loading: true, error: null });
        try {
          const response = await fetch('/api/user/api-config', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(config),
          });

          const data = await response.json();

          if (response.ok) {
            set({ loading: false });
            // 刷新配置列表
            get().fetchApiConfigs();
            return true;
          } else {
            set({ error: data.error || '保存失败', loading: false });
            return false;
          }
        } catch {
          set({ error: '网络错误', loading: false });
          return false;
        }
      },

      // 删除 API 配置
      deleteApiConfig: async (exchange: ExchangeType) => {
        const { token } = get();
        if (!token) return false;

        set({ loading: true, error: null });
        try {
          const response = await fetch(`/api/user/api-config?exchange=${exchange}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });

          if (response.ok) {
            set({ loading: false });
            // 刷新配置列表
            get().fetchApiConfigs();
            return true;
          } else {
            const data = await response.json();
            set({ error: data.error || '删除失败', loading: false });
            return false;
          }
        } catch {
          set({ error: '网络错误', loading: false });
          return false;
        }
      },

      // 测试连接
      testConnection: async (exchange: ExchangeType) => {
        const { token } = get();
        if (!token) {
          return { success: false, error: '未登录' };
        }

        try {
          const response = await fetch('/api/user/test-connection', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ exchange }),
          });

          return await response.json();
        } catch {
          return { success: false, error: '网络错误' };
        }
      },

      setActiveExchange: (exchange) => set({ activeExchange: exchange }),
      openSettings: () => set({ isSettingsOpen: true }),
      closeSettings: () => set({ isSettingsOpen: false }),
      clearError: () => set({ error: null }),
    }),
    {
      name: 'user-storage',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
        activeExchange: state.activeExchange,
      }),
    }
  )
);
