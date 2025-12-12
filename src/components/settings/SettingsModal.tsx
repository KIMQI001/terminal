"use client";

import { useEffect, useState } from "react";
import { useUserStore } from "@/stores/userStore";
import { ApiKeyForm } from "./ApiKeyForm";
import { PasswordForm } from "./PasswordForm";
import { InviteCodeManager } from "./InviteCodeManager";
import { DingtalkConfigForm } from "./DingtalkConfigForm";
import { Key, Lock, X, Users, Bell } from "lucide-react";

type SettingsTab = "api" | "notification" | "password" | "invite";

export function SettingsModal() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("api");

  const {
    isSettingsOpen,
    closeSettings,
    user,
    logout,
    fetchApiConfigs,
  } = useUserStore();

  // 打开设置时获取 API 配置
  useEffect(() => {
    if (isSettingsOpen) {
      fetchApiConfigs();
    }
  }, [isSettingsOpen, fetchApiConfigs]);

  if (!isSettingsOpen) return null;

  const isAdmin = user?.role === "admin";

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: "api", label: "API 配置", icon: <Key className="w-4 h-4" /> },
    { id: "notification", label: "通知", icon: <Bell className="w-4 h-4" /> },
    { id: "password", label: "密码", icon: <Lock className="w-4 h-4" /> },
    ...(isAdmin ? [{ id: "invite" as const, label: "邀请码", icon: <Users className="w-4 h-4" /> }] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={closeSettings}
      />

      {/* 模态框内容 */}
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <h2 className="text-lg font-semibold">设置</h2>
          <button
            onClick={closeSettings}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-md hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 用户信息 */}
        <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between shrink-0">
          <div>
            <span className="text-sm text-gray-500">当前用户: </span>
            <span className="font-medium">{user?.username}</span>
            {user?.role === "admin" && (
              <span className="ml-2 px-2 py-0.5 bg-amber-100 text-amber-700 text-xs rounded-full">
                管理员
              </span>
            )}
          </div>
          <button
            onClick={logout}
            className="text-sm text-red-600 hover:text-red-700 hover:underline"
          >
            退出登录
          </button>
        </div>

        {/* 标签页切换 */}
        <div className="flex border-b shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "text-blue-600 border-b-2 border-blue-600 bg-blue-50/50"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* 内容区域 */}
        <div className="overflow-y-auto flex-1">
          {activeTab === "api" && <ApiKeyForm />}
          {activeTab === "notification" && <DingtalkConfigForm />}
          {activeTab === "password" && <PasswordForm />}
          {activeTab === "invite" && isAdmin && <InviteCodeManager />}
        </div>
      </div>
    </div>
  );
}
