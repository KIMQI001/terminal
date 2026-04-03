"use client";

import { useState, useEffect } from "react";
import { useUserStore } from "@/stores/userStore";

interface NotificationConfig {
  dingtalkWebhook: string | null;
  dingtalkSecretConfigured?: boolean;
  enabled: boolean;
  positionMonitorEnabled?: boolean;
}

export function DingtalkConfigForm() {
  const [webhook, setWebhook] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [positionMonitorEnabled, setPositionMonitorEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isConfigured, setIsConfigured] = useState(false);

  const { token } = useUserStore();

  // 加载现有配置
  useEffect(() => {
    async function fetchConfig() {
      if (!token) return;

      setLoading(true);
      try {
        const res = await fetch("/api/user/notification-config", {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const data = await res.json();
          const config: NotificationConfig = data.config;

          if (config.dingtalkWebhook) {
            setWebhook(config.dingtalkWebhook);
            setIsConfigured(true);
          }
          setEnabled(config.enabled);
          setPositionMonitorEnabled(config.positionMonitorEnabled ?? false);
        }
      } catch (error) {
        console.error("Failed to fetch notification config:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchConfig();
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/user/notification-config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          dingtalkWebhook: webhook || null,
          dingtalkSecret: secret || null,
          enabled,
          positionMonitorEnabled,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setMessage({ type: "success", text: "钉钉配置已保存" });
        setSecret(""); // 清空 secret 输入
        if (webhook) setIsConfigured(true);
      } else {
        setMessage({ type: "error", text: data.error || "保存失败" });
      }
    } catch (error) {
      setMessage({ type: "error", text: "网络错误" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!token) return;
    if (!confirm("确定要删除钉钉配置吗？")) return;

    setSaving(true);
    try {
      const res = await fetch("/api/user/notification-config", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        setWebhook("");
        setSecret("");
        setEnabled(true);
        setPositionMonitorEnabled(false);
        setIsConfigured(false);
        setMessage({ type: "success", text: "配置已删除" });
      }
    } catch (error) {
      setMessage({ type: "error", text: "删除失败" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4 text-center text-gray-500">
        加载中...
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="text-sm text-gray-600 bg-blue-50 p-3 rounded-lg">
        配置钉钉机器人后，订单成交、止盈止损等通知将发送到你的钉钉群。
        如未配置，将使用系统默认钉钉群。
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Webhook URL
          </label>
          <input
            type="url"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            从钉钉群机器人设置中获取
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            加签密钥 (Secret)
            {isConfigured && (
              <span className="ml-2 text-green-600 text-xs">已配置</span>
            )}
          </label>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={isConfigured ? "留空保持原密钥不变" : "SEC..."}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            机器人安全设置中的加签密钥
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <label htmlFor="enabled" className="text-sm text-gray-700">
            启用钉钉通知
          </label>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="positionMonitorEnabled"
            checked={positionMonitorEnabled}
            onChange={(e) => setPositionMonitorEnabled(e.target.checked)}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <label htmlFor="positionMonitorEnabled" className="text-sm text-gray-700">
            仓位监控（手动下单入场成交后自动挂止损单并发送通知）
          </label>
        </div>

        {message && (
          <div
            className={`p-3 rounded-lg text-sm ${
              message.type === "success"
                ? "bg-green-50 text-green-700"
                : "bg-red-50 text-red-700"
            }`}
          >
            {message.text}
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
          >
            {saving ? "保存中..." : "保存配置"}
          </button>

          {isConfigured && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving}
              className="px-4 py-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 disabled:opacity-50 text-sm font-medium"
            >
              删除
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
