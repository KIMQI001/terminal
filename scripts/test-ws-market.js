/**
 * Binance WebSocket 测试 (Market 入口)
 *
 * 用法:
 *   node test-ws-market.js
 */

const WebSocket = require('ws');

console.log('===========================================');
console.log('Binance WebSocket 测试 (Market 入口)');
console.log('===========================================');

// USDC 合约 K线
const stream = 'btcusdc@kline_1m';
const url = `wss://fstream.binance.com/market/ws/${stream}`;

console.log('Stream:', stream);
console.log('URL:', url);
console.log('');

const ws = new WebSocket(url);
let msgCount = 0;
const startTime = Date.now();

const timeout = setTimeout(() => {
  console.log('[超时] 30秒内没有收到 K线消息');
  console.log('[统计] 共收到', msgCount, '条消息');
  ws.close();
  process.exit(msgCount > 0 ? 0 : 1);
}, 30000);

ws.on('open', () => {
  console.log('[✓] 连接成功，等待 K线推送...');
  console.log('[当前时间]', new Date().toISOString());
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[<] 收到:', JSON.stringify(msg).substring(0, 200));

  // 普通 K线格式: {"stream":"btcusdt@kline_1m","data":{"e":"kline",...}}
  const k = msg.data?.k || msg.k;
  const e = msg.data?.e || msg.e;

  if (e === 'kline' && k) {
    msgCount++;
    console.log('');
    console.log('[✓] K线数据 #' + msgCount + '!');
    console.log('    交易对:', k.s);
    console.log('    时间周期:', k.i);
    console.log('    开盘:', k.o, '| 当前:', k.c);
    console.log('    最高:', k.h, '| 最低:', k.l);
    console.log('    成交量:', k.v);

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