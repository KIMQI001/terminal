/**
 * Binance WS-FAPI WebSocket 测试
 *
 * 用法:
 *   node test-ws-fapi.js
 */

const WebSocket = require('ws');

console.log('===========================================');
console.log('Binance WS-FAPI WebSocket 测试');
console.log('===========================================');

const url = 'wss://ws-fapi.binance.com/ws-fapi/v1/btcusdc@kline_1m';
console.log('端点:', url);
console.log('');

const ws = new WebSocket(url);
let msgCount = 0;
const startTime = Date.now();

const timeout = setTimeout(() => {
  console.log('[超时] 60秒内没有收到 K线消息');
  console.log('[统计] 共收到', msgCount, '条消息');
  if (msgCount === 0) {
    console.log('[失败] WebSocket 无法接收数据');
  } else {
    console.log('[部分成功] 连接正常但数据不完整');
  }
  ws.close();
  process.exit(msgCount > 0 ? 0 : 1);
}, 60000);

ws.on('open', () => {
  console.log('[✓] 连接成功，等待 K线推送...');
  console.log('[当前时间]', new Date().toISOString());
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[收到消息]', JSON.stringify(msg).substring(0, 200));

  if (msg.e === 'kline' || msg.data?.k) {
    msgCount++;
    const k = msg.e === 'kline' ? msg.k : msg.data?.k;
    if (k) {
      console.log('');
      console.log('[✓] K线数据 #' + msgCount + '!');
      console.log('    交易对:', k.s);
      console.log('    时间周期:', k.i);
      console.log('    开盘:', k.o, '| 当前:', k.c);
      console.log('    最高:', k.h, '| 最低:', k.l);
      console.log('    成交量:', k.v);
      console.log('    收盘:', k.x ? '是' : '否');
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