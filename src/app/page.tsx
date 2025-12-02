"use client";

import { Header } from "@/components/layout/Header";
import { StatusBar } from "@/components/layout/StatusBar";
import { TradingChart } from "@/components/chart/TradingChart";
import { TradePanel } from "@/components/trading/TradePanel";
import { AuthGuard } from "@/components/auth/AuthGuard";

export default function Home() {
  return (
    <AuthGuard>
      <div className="flex flex-col h-screen bg-[var(--bg-primary)]">
        <Header />
        <main className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-hidden">
            <TradingChart />
          </div>
          <TradePanel />
        </main>
        <StatusBar />
      </div>
    </AuthGuard>
  );
}
