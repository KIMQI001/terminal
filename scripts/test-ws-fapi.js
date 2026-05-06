/**
 * Binance WS-FAPI WebSocket 测试
 *
 * 用法:
 *   node test-ws-fapi.js
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

console.log('===========================================');
console.log('Binance WS-FAPI WebSocket 测试');
console.log('===========================================');

const url = 'wss://ws-fapi.binance.com/ws-fapi/v1';
console.log('端点:', url);
console.log('');

const ws = new WebSocket(url);
let msgCount = 0;
let subscribed = false;
const startTime = Date.now();

const timeout = setTimeout(() => {
  console.log('[超时] 60秒内没有收到 K线消息');
  console.log('[统计] 共收到', msgCount, '条消息');
  ws.close();
  process.exit(msgCount > 0 ? 0 : 1);
}, 60000);

ws.on('open', () => {
  console.log('[✓] 连接成功，发送订阅请求...');

  // 发送 K线订阅请求（新格式）
  const subscribeMsg = {
    id: uuidv4(),
    method: "kline.public",
    params: {
      symbol: "BTCUSDT",
      interval: "1m"
    }
  };

  console.log('[>] 发送:', JSON.stringify(subscribeMsg));
  ws.send(JSON.stringify(subscribeMsg));
  subscribed = true;
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[<] 收到:', JSON.stringify(msg).substring(0, 200));

  // 检查是否是 K线数据
  if (msg.method === "kline.public" || msg.data?.k) {
    msgCount++;
    const k = msg.data?.k || msg;
    if (k.s && k.o) {
      console.log('');
      console.log('[✓] K线数据 #' + msgCount + '!');
      console.log('    交易对:', k.s);
      console.log('    时间周期:', k.i || k.interval);
      console.log('    开盘:', k.o, '| 当前:', k.c);
      console.log('    最高:', k.h, '| 最低:', k.l);
      console.log('    成交量:', k.v);
    }

    if (msgCount >= 2) {
      clearTimeout(timeout);
      console.log('');
      console.log('[成功] WebSocket 正常工作!');
      console.log('[耗时]', ((Date.now() - startTime) / 1000).toFixed(1), '秒');
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (err) => {
  clearTimeout(timeout);
  console.error('[✗] 错误:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('[关闭] 连接已关闭');
});