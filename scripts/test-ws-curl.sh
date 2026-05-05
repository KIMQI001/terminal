#!/bin/bash
# WebSocket 测试脚本（使用 curl）

echo "==========================================="
echo "Binance WebSocket 测试 (curl)"
echo "==========================================="
echo ""
echo "测试连接: wss://fstream.binance.com/ws/btcusdt@kline_1m"
echo ""

# 使用 curl 连接 WebSocket 并发送订阅，然后等待消息
timeout 5 curl -v \
  --no-buffer \
  -H "Upgrade: websocket" \
  -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  "https://fstream.binance.com/ws/btcusdt@kline_1m" 2>&1 | head -50

echo ""
echo "==========================================="
echo "如果连接被拒绝，检查:"
echo "1. 防火墙设置"
echo "2. Cloudflare 或 CDN 配置"
echo "3. 联系 VPS 提供商确认是否屏蔽了 Binance IP"
echo "==========================================="
