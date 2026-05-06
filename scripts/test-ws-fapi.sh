#!/bin/bash
# Binance WebSocket 测试脚本

echo "=========================================="
echo "Binance WS-FAPI WebSocket 测试"
echo "=========================================="
echo ""
echo "测试端点: wss://ws-fapi.binance.com/ws-fapi/v1"
echo "订阅: btcusdc@kline_1m"
echo ""

# 使用 curl 测试 WebSocket 连接（简短超时）
echo "1. 测试 WebSocket 连接..."
timeout 3 curl -v \
  --no-buffer \
  -H "Upgrade: websocket" \
  -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  "wss://ws-fapi.binance.com/ws-fapi/v1/btcusdc@kline_1m" 2>&1 | head -30

echo ""
echo "=========================================="
echo "如果连接成功，说明端点可用"
echo "如果连接被拒绝，说明有问题"
echo "==========================================="