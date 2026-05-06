#!/bin/bash
# Binance WebSocket 测试脚本

echo "=========================================="
echo "Binance WS-FAPI WebSocket 测试"
echo "=========================================="
echo ""
echo "测试端点: wss://ws-fapi.binance.com/ws-fapi/v1"
echo "订阅: btcusdc@kline_1m"
echo ""

# 使用 websocat 测试 WebSocket 连接
if command -v websocat &> /dev/null; then
  echo "使用 websocat 测试..."
  timeout 5 websocat "wss://ws-fapi.binance.com/ws-fapi/v1/btcusdc@kline_1m" 2>&1 | head -20
else
  echo "websocat 未安装，尝试使用 wscat..."
  if command -v wscat &> /dev/null; then
    timeout 5 wscat -c "wss://ws-fapi.binance.com/ws-fapi/v1/btcusdc@kline_1m" 2>&1 | head -20
  else
    echo ""
    echo "请安装 websocat 或 wscat 来测试 WebSocket:"
    echo "  brew install websocat"
    echo "  npm install -g wscat"
    echo ""
    echo "或者使用 Node.js 测试脚本:"
    echo "  node scripts/test-ws-fapi.js"
  fi
fi

echo ""
echo "==========================================="