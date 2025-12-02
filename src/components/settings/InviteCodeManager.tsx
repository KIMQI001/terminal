"use client";

import { useState, useEffect, useCallback } from "react";
import { useUserStore } from "@/stores/userStore";
import { Copy, Trash2, Plus, Check } from "lucide-react";

interface InviteCode {
  id: number;
  code: string;
  usedBy: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export function InviteCodeManager() {
  const { token } = useUserStore();
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const fetchCodes = useCallback(async () => {
    if (!token) return;

    setLoading(true);
    try {
      const response = await fetch("/api/admin/invite-codes", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await response.json();
      if (data.success) {
        setCodes(data.codes);
      } else {
        setError(data.error);
      }
    } catch {
      setError("获取邀请码列表失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchCodes();
  }, [fetchCodes]);

  const handleCreate = async () => {
    if (!token) return;

    setCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/invite-codes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ expiresInDays: 7 }), // 7天有效期
      });

      const data = await response.json();
      if (data.success) {
        fetchCodes();
      } else {
        setError(data.error);
      }
    } catch {
      setError("创建邀请码失败");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!token) return;

    try {
      const response = await fetch(`/api/admin/invite-codes?id=${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await response.json();
      if (data.success) {
        fetchCodes();
      } else {
        setError(data.error);
      }
    } catch {
      setError("删除邀请码失败");
    }
  };

  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch {
      setError("复制失败");
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "-";
    return new Date(dateStr).toLocaleString("zh-CN");
  };

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium">邀请码管理</h3>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {creating ? "创建中..." : "生成邀请码"}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-2 bg-red-50 text-red-600 text-sm rounded">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-500">加载中...</div>
      ) : codes.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          暂无邀请码，点击上方按钮生成
        </div>
      ) : (
        <div className="space-y-2">
          {codes.map((code) => (
            <div
              key={code.id}
              className={`p-3 rounded-lg border ${
                code.usedBy
                  ? "bg-gray-50 border-gray-200"
                  : "bg-green-50 border-green-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-sm font-medium">
                    {code.code}
                  </code>
                  {!code.usedBy && (
                    <button
                      onClick={() => handleCopy(code.code)}
                      className="p-1 text-gray-500 hover:text-blue-600 rounded"
                      title="复制"
                    >
                      {copiedCode === code.code ? (
                        <Check className="w-4 h-4 text-green-600" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  )}
                </div>

                {!code.usedBy && (
                  <button
                    onClick={() => handleDelete(code.id)}
                    className="p-1 text-gray-400 hover:text-red-600 rounded"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="mt-2 text-xs text-gray-500 space-y-0.5">
                {code.usedBy ? (
                  <p>
                    <span className="text-green-600">已使用</span> - 用户:{" "}
                    {code.usedBy} ({formatDate(code.usedAt)})
                  </p>
                ) : (
                  <>
                    <p>创建时间: {formatDate(code.createdAt)}</p>
                    {code.expiresAt && (
                      <p>
                        过期时间: {formatDate(code.expiresAt)}
                        {new Date(code.expiresAt) < new Date() && (
                          <span className="ml-1 text-red-500">(已过期)</span>
                        )}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
