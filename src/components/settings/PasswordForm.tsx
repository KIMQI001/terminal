"use client";

import { useState } from "react";
import { useUserStore } from "@/stores/userStore";

export function PasswordForm() {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const { changePassword, loading } = useUserStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResult(null);

    // 验证确认密码
    if (newPassword !== confirmPassword) {
      setResult({ success: false, message: "两次输入的新密码不一致" });
      return;
    }

    if (newPassword.length < 6) {
      setResult({ success: false, message: "新密码长度至少 6 个字符" });
      return;
    }

    const success = await changePassword(oldPassword, newPassword);

    if (success) {
      setResult({ success: true, message: "密码修改成功" });
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } else {
      setResult({ success: false, message: "密码修改失败，请检查原密码是否正确" });
    }
  };

  return (
    <div className="p-4">
      <h3 className="text-lg font-medium mb-4">修改密码</h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            原密码
          </label>
          <input
            type="password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="请输入原密码"
            required
            autoComplete="current-password"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            新密码
          </label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="请输入新密码 (至少6位)"
            required
            minLength={6}
            autoComplete="new-password"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            确认新密码
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="请再次输入新密码"
            required
            minLength={6}
            autoComplete="new-password"
          />
        </div>

        {result && (
          <div
            className={`text-sm p-2 rounded ${
              result.success
                ? "bg-green-50 text-green-600"
                : "bg-red-50 text-red-600"
            }`}
          >
            {result.message}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !oldPassword || !newPassword || !confirmPassword}
          className="w-full py-2 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "处理中..." : "修改密码"}
        </button>
      </form>
    </div>
  );
}
