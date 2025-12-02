"use client";

import { useState } from "react";
import { useUserStore } from "@/stores/userStore";
import { ExchangeType } from "@/types/user";

const EXCHANGES: { value: ExchangeType; label: string; available: boolean }[] = [
  { value: "binance", label: "Binance", available: true },
  { value: "okx", label: "OKX", available: false },
  { value: "bitget", label: "Bitget", available: false },
  { value: "hyperliquid", label: "Hyperliquid", available: false },
];

export function ApiKeyForm() {
  const [exchange, setExchange] = useState<ExchangeType>("binance");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [isTestnet, setIsTestnet] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const { saveApiConfig, testConnection, loading, error, apiConfigs } = useUserStore();

  // 检查当前交易所是否已配置
  const isConfigured = apiConfigs.some((c) => c.exchange === exchange);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestResult(null);

    const success = await saveApiConfig({
      exchange,
      apiKey,
      apiSecret,
      passphrase: exchange === "okx" ? passphrase : undefined,
      isTestnet,
    });

    if (success) {
      setTestResult({ success: true, message: "API 配置已保存" });
      // 清空表单
      setApiKey("");
      setApiSecret("");
      setPassphrase("");
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);

    const result = await testConnection(exchange);

    if (result.success) {
      const balanceInfo = result.balance
        ?.slice(0, 3)
        .map((b) => `${b.asset}: ${parseFloat(b.free).toFixed(4)}`)
        .join(", ");
      setTestResult({
        success: true,
        message: `连接成功! ${balanceInfo || ""}`,
      });
    } else {
      setTestResult({
        success: false,
        message: result.error || "连接失败",
      });
    }

    setIsTesting(false);
  };

  return (
    <div className="p-4">
      <h3 className="text-lg font-medium mb-4">API 配置</h3>

      {/* 已配置的交易所列表 */}
      {apiConfigs.length > 0 && (
        <div className="mb-4 p-3 bg-gray-50 rounded-lg">
          <div className="text-sm font-medium text-gray-600 mb-2">已配置:</div>
          <div className="flex flex-wrap gap-2">
            {apiConfigs.map((config) => (
              <span
                key={config.exchange}
                className="inline-flex items-center px-2 py-1 bg-green-100 text-green-800 text-xs rounded"
              >
                {EXCHANGES.find((e) => e.value === config.exchange)?.label}
                {config.isTestnet && " (测试网)"}
              </span>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-4">
        {/* 交易所选择 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            交易所
          </label>
          <select
            value={exchange}
            onChange={(e) => setExchange(e.target.value as ExchangeType)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {EXCHANGES.map((ex) => (
              <option key={ex.value} value={ex.value} disabled={!ex.available}>
                {ex.label} {!ex.available && "(即将支持)"}
              </option>
            ))}
          </select>
        </div>

        {/* API Key */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            API Key
          </label>
          <input
            type="text"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
            placeholder={isConfigured ? "已配置 (输入新值覆盖)" : "请输入 API Key"}
          />
        </div>

        {/* API Secret */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            API Secret
          </label>
          <input
            type="password"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
            placeholder={isConfigured ? "已配置 (输入新值覆盖)" : "请输入 API Secret"}
          />
        </div>

        {/* Passphrase (仅 OKX) */}
        {exchange === "okx" && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Passphrase
            </label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              placeholder="请输入 Passphrase"
            />
          </div>
        )}

        {/* 测试网选项 */}
        <div className="flex items-center">
          <input
            type="checkbox"
            id="testnet"
            checked={isTestnet}
            onChange={(e) => setIsTestnet(e.target.checked)}
            className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <label htmlFor="testnet" className="ml-2 text-sm text-gray-700">
            使用测试网
          </label>
        </div>

        {/* 结果提示 */}
        {(error || testResult) && (
          <div
            className={`text-sm p-2 rounded ${
              testResult?.success
                ? "bg-green-50 text-green-600"
                : "bg-red-50 text-red-600"
            }`}
          >
            {error || testResult?.message}
          </div>
        )}

        {/* 按钮组 */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleTest}
            disabled={!isConfigured || isTesting}
            className="flex-1 py-2 px-4 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isTesting ? "测试中..." : "测试连接"}
          </button>
          <button
            type="submit"
            disabled={loading || !apiKey || !apiSecret}
            className="flex-1 py-2 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "保存中..." : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
