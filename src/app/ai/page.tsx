'use client';

import { AgentControl } from '@/components/ai/AgentControl';
import { Header } from '@/components/layout/Header';
import { StatusBar } from '@/components/layout/StatusBar';

export default function AIPage() {
  return (
    <div className="flex flex-col h-screen bg-[var(--bg-primary)]">
      <Header />
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <h1 className="text-2xl font-bold mb-6">AI 助手</h1>

          {/* 自主代理 */}
          <AgentControl className="w-full" />

          {/* 使用说明 */}
          <div className="bg-[var(--bg-secondary)] rounded-lg p-4 text-sm text-[var(--text-secondary)]">
            <h3 className="font-medium text-[var(--text-primary)] mb-2">使用说明</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>自主代理会按设定的时间间隔自动分析 BTC 行情</li>
              <li>开启钉钉通知后，每次分析结果会发送到你的钉钉群</li>
              <li>右下角聊天按钮可以随时与 AI 助手对话</li>
              <li>图表左上角会显示实时 AI 分析摘要</li>
            </ul>
          </div>
        </div>
      </main>
      <StatusBar />
    </div>
  );
}
