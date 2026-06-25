"use client";

import { useState, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChartStore } from "@/stores/chartStore";
import { useOrderStore, TradingLine } from "@/stores/orderStore";
import { usePositionStore } from "@/stores/positionStore";
import { OrderType, OrderSide } from "@/types/order";

const orderTypes: { value: OrderType; label: string }[] = [
  { value: "limit", label: "限价" },
  { value: "market", label: "市价" },
];

const leverageOptions = [5, 20, 50, 100];
const PERCENTAGE_PRESETS = [25, 33, 50];
const STORAGE_KEY = 'order-percentage-presets';

export function OrderForm() {
  const { symbol, candles } = useChartStore();
  const { placeOrder, isPlacingOrder, orderError, prefillData, setPrefillData, setTradingLines } = useOrderStore();
  const { getBalance, currentLeverage, isLoadingLeverage, fetchLeverage, setLeverage } = usePositionStore();

  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [selectedSide, setSelectedSide] = useState<OrderSide | null>(null);
  const [price, setPrice] = useState<string>("");
  const [amountPercent, setAmountPercent] = useState<string>("");
  const [stopLoss, setStopLoss] = useState<string>("");
  const [takeProfit, setTakeProfit] = useState<string>("");

  const [isSettingLeverage, setIsSettingLeverage] = useState(false);
  const [percentagePresets, setPercentagePresets] = useState<number[]>(PERCENTAGE_PRESETS);
  const [isEditingPresets, setIsEditingPresets] = useState(false);
  const [editingPresets, setEditingPresets] = useState<string[]>(PERCENTAGE_PRESETS.map(String));

  // 从 localStorage 加载预设值
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === PERCENTAGE_PRESETS.length) {
          setPercentagePresets(parsed);
          setEditingPresets(parsed.map(String));
        }
      } catch {
        // 忽略解析错误
      }
    }
  }, []);

  const lastPrice = candles[candles.length - 1]?.close || 0;
  const baseAsset = symbol.replace("USDT", "").replace("USDC", "");

  // 获取当前杠杆
  useEffect(() => {
    if (symbol) {
      fetchLeverage(symbol);
    }
  }, [symbol, fetchLeverage]);

  // 设置杠杆
  const handleSetLeverage = async (leverage: number) => {
    setIsSettingLeverage(true);
    await setLeverage(symbol, leverage);
    setIsSettingLeverage(false);
  };

  // 根据交易对判断使用 USDC 还是 USDT
  const quoteAsset = symbol.endsWith("USDC") ? "USDC" : "USDT";
  const quoteBalance = getBalance(quoteAsset);

  // 监听prefillData变化，自动填充表单
  useEffect(() => {
    if (prefillData) {
      setOrderType("limit");
      setSelectedSide(prefillData.side);
      setPrice(prefillData.entry.toFixed(2));
      setStopLoss(prefillData.stopLoss.toFixed(2));
      setTakeProfit(prefillData.takeProfit.toFixed(2));
    }
  }, [prefillData]);

  // 监听价格输入变化，同步更新图表线条
  useEffect(() => {
    if (!selectedSide) return;

    const entry = parseFloat(price) || 0;
    const sl = parseFloat(stopLoss) || 0;
    const tp = parseFloat(takeProfit) || 0;

    // 入场价格清空时，清除所有线条
    if (entry <= 0) {
      setTradingLines([]);
      return;
    }

    const lines: TradingLine[] = [];
    lines.push({ price: entry, type: "entry", side: selectedSide });
    if (sl > 0) lines.push({ price: sl, type: "stopLoss", side: selectedSide });
    if (tp > 0) lines.push({ price: tp, type: "takeProfit", side: selectedSide });

    setTradingLines(lines);
  }, [price, stopLoss, takeProfit, selectedSide, setTradingLines]);

  // 计算实际 USDT 金额（百分比 × 余额）
  const actualUSD = useMemo(() => {
    const pct = parseFloat(amountPercent) || 0;
    const free = quoteBalance?.free || 0;
    return free * pct / 100;
  }, [amountPercent, quoteBalance]);

  // 计算币数量（保证金 * 杠杆 / 价格）
  const coinQuantity = useMemo(() => {
    const p = orderType === "market" ? lastPrice : parseFloat(price) || 0;
    if (p <= 0) return 0;
    // actualUSD 是保证金，乘以杠杆得到实际开仓价值
    return (actualUSD * currentLeverage) / p;
  }, [orderType, price, actualUSD, lastPrice, currentLeverage]);

  // 点击预设百分比
  const handlePresetPercent = (pct: number) => {
    setAmountPercent(pct.toString());
  };

  // 保存预设值
  const handleSavePresets = () => {
    const newPresets = editingPresets.map(v => parseFloat(v) || 0).filter(v => v > 0);
    if (newPresets.length === PERCENTAGE_PRESETS.length) {
      setPercentagePresets(newPresets);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newPresets));
      setIsEditingPresets(false);
    }
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setEditingPresets(percentagePresets.map(String));
    setIsEditingPresets(false);
  };

  const handleSubmit = async (side: OrderSide) => {
    // 入场价（限价用 price，市价用最新价）
    const entryPrice = orderType === "market" ? lastPrice : parseFloat(price) || 0;
    if (entryPrice <= 0) return;

    // 强制 SL = 入场价 ± 200 点（LONG: -200，SHORT: +200）
    const slOffset = side === "buy" ? -200 : 200;
    const finalStopLoss = entryPrice + slOffset;

    // 为手动下单生成 clientOrderIdPrefix，格式: m_{timestamp}
    // 使用短前缀 'm' 保证 clientAlgoId 不超过 36 字符限制
    // 止盈止损单通过 _sl, _tp 后缀与主单关联，实现订单分组
    const clientOrderIdPrefix = `m_${Date.now()}`;

    const orderData = {
      type: orderType,
      side,
      price: orderType !== "market" ? parseFloat(price) : undefined,
      stopPrice: finalStopLoss,
      takeProfit: takeProfit ? parseFloat(takeProfit) : undefined,
      quantity: coinQuantity, // 使用计算出的币数量
      clientOrderIdPrefix,
    };

    const result = await placeOrder(orderData, symbol);

    if (result.success) {
      // Reset form
      setAmountPercent("");
      setStopLoss("");
      setTakeProfit("");
      setSelectedSide(null);
      setPrefillData(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* 订单类型选择 */}
      <div className="flex gap-1 p-1 bg-[var(--bg-tertiary)] rounded-lg">
        {orderTypes.map((type) => (
          <button
            key={type.value}
            onClick={() => setOrderType(type.value)}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
              orderType === type.value
                ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {type.label}
          </button>
        ))}
      </div>

      {/* 杠杆设置 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs text-[var(--text-secondary)]">杠杆</label>
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            {isLoadingLeverage ? '...' : `${currentLeverage}x`}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {leverageOptions.map((lev) => (
            <button
              key={lev}
              onClick={() => handleSetLeverage(lev)}
              disabled={isSettingLeverage || isLoadingLeverage}
              className={`py-1.5 text-xs font-medium rounded transition-colors ${
                currentLeverage === lev
                  ? "bg-blue-500 text-white"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]"
              } ${(isSettingLeverage || isLoadingLeverage) ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {lev}x
            </button>
          ))}
        </div>
      </div>

      {/* 方向指示 (来自OTE) */}
      {selectedSide && (
        <div className={`text-xs font-medium px-2 py-1 rounded ${
          selectedSide === 'buy'
            ? 'bg-blue-100 text-blue-700'
            : 'bg-purple-100 text-purple-700'
        }`}>
          OTE {selectedSide === 'buy' ? '看涨 (BUY)' : '看跌 (SELL)'}
        </div>
      )}

      {/* 价格输入 */}
      {orderType !== "market" && (
        <div className="space-y-1.5">
          <label className="text-xs text-[var(--text-secondary)]">入场价格</label>
          <Input
            type="number"
            placeholder="入场价格"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            suffix="USDT"
          />
        </div>
      )}

      {/* 止损输入 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs text-[var(--text-secondary)]">止损 (SL)</label>
          <span className="text-xs text-orange-500">下单时强制 ±200</span>
        </div>
        <Input
          type="number"
          placeholder="止损价格"
          value={stopLoss}
          onChange={(e) => setStopLoss(e.target.value)}
          suffix="USDT"
        />
      </div>

      {/* 止盈输入 */}
      <div className="space-y-1.5">
        <label className="text-xs text-[var(--text-secondary)]">止盈 (TP)</label>
        <Input
          type="number"
          placeholder="止盈价格"
          value={takeProfit}
          onChange={(e) => setTakeProfit(e.target.value)}
          suffix="USDT"
        />
      </div>

      {/* 仓位百分比输入 */}
      <div className="space-y-1.5">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--text-secondary)]">仓位</label>
            {!isEditingPresets && (
              <button
                onClick={() => setIsEditingPresets(true)}
                className="text-xs text-blue-500 hover:text-blue-600"
              >
                ✏️
              </button>
            )}
          </div>
          <span className="text-xs text-[var(--text-secondary)]">
            可用: {quoteBalance?.free.toLocaleString() || 0} {quoteAsset}
          </span>
        </div>

        {/* 百分比预设按钮 */}
        {isEditingPresets ? (
          <div className="space-y-2">
            <div className={`grid gap-1`} style={{ gridTemplateColumns: `repeat(${PERCENTAGE_PRESETS.length}, minmax(0, 1fr))` }}>
              {editingPresets.map((value, index) => (
                <input
                  key={index}
                  type="number"
                  value={value}
                  onChange={(e) => {
                    const newPresets = [...editingPresets];
                    newPresets[index] = e.target.value;
                    setEditingPresets(newPresets);
                  }}
                  className="w-full py-1 px-2 text-xs text-center bg-[var(--bg-tertiary)] border border-[var(--border)] rounded focus:outline-none focus:border-blue-500"
                />
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSavePresets}
                className="flex-1 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
              >
                保存
              </button>
              <button
                onClick={handleCancelEdit}
                className="flex-1 py-1 text-xs bg-[var(--bg-tertiary)] rounded hover:bg-[var(--border)] transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className={`grid gap-1`} style={{ gridTemplateColumns: `repeat(${PERCENTAGE_PRESETS.length}, minmax(0, 1fr))` }}>
            {percentagePresets.map((pct) => (
              <button
                key={pct}
                onClick={() => handlePresetPercent(pct)}
                className={`py-1.5 text-xs rounded transition-colors ${
                  parseFloat(amountPercent) === pct
                    ? 'bg-blue-500 text-white'
                    : 'bg-[var(--bg-tertiary)] hover:bg-[var(--border)]'
                }`}
              >
                {pct}%
              </button>
            ))}
          </div>
        )}

        <Input
          type="number"
          placeholder="百分比"
          value={amountPercent}
          onChange={(e) => setAmountPercent(e.target.value)}
          suffix="%"
        />
        <div className="text-xs text-[var(--text-secondary)] space-y-0.5">
          <div>≈ {actualUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })} {quoteAsset}</div>
          <div>≈ {coinQuantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} {baseAsset}</div>
        </div>
      </div>

      {/* 错误提示 */}
      {orderError && (
        <div className="text-xs text-red-500 bg-red-50 px-2 py-1.5 rounded">
          {orderError}
        </div>
      )}

      {/* 买入/卖出按钮 */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          onClick={() => handleSubmit("buy")}
          disabled={isPlacingOrder || !amountPercent || parseFloat(amountPercent) <= 0 || coinQuantity <= 0}
          className={`text-white ${
            selectedSide === 'buy'
              ? 'bg-blue-600 hover:bg-blue-700 ring-2 ring-blue-300'
              : 'bg-[var(--positive)] hover:bg-[var(--positive)]/90'
          }`}
        >
          {isPlacingOrder ? '下单中...' : '买入 / 做多'}
        </Button>
        <Button
          onClick={() => handleSubmit("sell")}
          disabled={isPlacingOrder || !amountPercent || parseFloat(amountPercent) <= 0 || coinQuantity <= 0}
          className={`text-white ${
            selectedSide === 'sell'
              ? 'bg-purple-600 hover:bg-purple-700 ring-2 ring-purple-300'
              : 'bg-[var(--negative)] hover:bg-[var(--negative)]/90'
          }`}
        >
          {isPlacingOrder ? '下单中...' : '卖出 / 做空'}
        </Button>
      </div>
    </div>
  );
}
