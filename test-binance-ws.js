/**
 * Binance WebSocket 测试脚本
 *
 * 用法:
 *   node test-binance-ws.js
 *
 * 依赖:
 *   npm install ws
 */

const WebSocket = require('ws');

const SYMBOL = 'btcusdt';
const TIMEFRAME = '1m';
const URL = `wss://fstream.binance.com/ws/${SYMBOL}@kline_${TIMEFRAME}`;

console.log('===========================================');
console.log('Binance WebSocket 测试');
console.log('===========================================');
console.log(`URL: ${URL}`);
console.log('');

const ws = new WebSocket(URL);

let messageCount = 0;
const startTime = Date.now();

ws.on('open', () => {
  console.log('[✓] WebSocket 连接成功');
  console.log('');
});

ws.on('message', (data) => {
  messageCount++;
  const msg = JSON.parse(data.toString());

  if (msg.e === 'kline') {
    const k = msg.k;
    const time = new Date(k.t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log(`[${messageCount}] K线更新: ${time}`);
    console.log(`    开盘: ${k.o}, 当前: ${k.c}, 最高: ${k.h}, 最低: ${k.l}`);
    console.log(`    成交量: ${k.v}, 收盘: ${k.x ? '是' : '否'}`);

    // 只打印前3条消息，然后退出
    if (messageCount >= 3) {
      console.log('');
      console.log('[✓] 测试成功! Binance WebSocket 正常工作');
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`[i] 收到 ${messageCount} 条消息，耗时 ${elapsed.toFixed(1)} 秒`);
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (error) => {
  console.error('[✗] WebSocket 错误:', error.message);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log(`'[✗] 连接关闭: code=${code}, reason=${reason || '无'}`);
  if (messageCount === 0) {
    console.log('[✗] 没有收到任何消息，Binance WebSocket 可能有问题');
    process.exit(1);
  }
});

// 30 秒超时
setTimeout(() => {
  console.log('');
  console.log('[✗] 超时 (30秒)');
  console.log(`[i] 收到 ${messageCount} 条消息`);
  ws.close();
  process.exit(1);
}, 30000);