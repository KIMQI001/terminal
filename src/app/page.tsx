"use client";

import { useState, useEffect } from "react";
import { Header } from "@/components/layout/Header";
import { StatusBar } from "@/components/layout/StatusBar";
import { TradingChart } from "@/components/chart/TradingChart";
import { TradePanel } from "@/components/trading/TradePanel";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { ChatPanel } from "@/components/ai/ChatPanel";
import { InlineAIDisplay } from "@/components/ai/InlineAIDisplay";
import { useChatStore } from "@/stores/chatStore";
import { MessageSquare } from "lucide-react";

// 横屏提示组件
function LandscapePrompt() {
  return (
    <div className="fixed inset-0 bg-[var(--bg-primary)] flex flex-col items-center justify-center z-50">
      <div className="text-6xl mb-4">📱↔️</div>
      <div className="text-xl font-medium text-[var(--text-primary)] mb-2">
        请横屏使用
      </div>
      <div className="text-sm text-[var(--text-secondary)]">
        为获得最佳体验，请将设备横向放置
      </div>
    </div>
  );
}

export default function Home() {
  const [isLandscape, setIsLandscape] = useState(true);
  const { isOpen: isChatOpen, setOpen: setChatOpen } = useChatStore();

  useEffect(() => {
    const checkWidth = () => {
      setIsLandscape(window.innerWidth >= 1024);
    };

    checkWidth();
    window.addEventListener("resize", checkWidth);
    return () => window.removeEventListener("resize", checkWidth);
  }, []);

  return (
    <AuthGuard>
      {!isLandscape && <LandscapePrompt />}
      <div className="flex flex-col h-screen bg-[var(--bg-primary)]">
        <Header />
        <main className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <TradingChart />
            <InlineAIDisplay />
          </div>
          <TradePanel />
        </main>
        <StatusBar />

        {/* 悬浮聊天按钮 */}
        {!isChatOpen && (
          <button
            onClick={() => setChatOpen(true)}
            className="fixed bottom-20 right-4 w-14 h-14 bg-blue-500 hover:bg-blue-600 text-white rounded-full shadow-lg flex items-center justify-center z-50 transition-all hover:scale-105"
          >
            <MessageSquare className="w-6 h-6" />
          </button>
        )}

        <ChatPanel />
      </div>
    </AuthGuard>
  );
}
