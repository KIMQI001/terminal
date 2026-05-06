/**
 * Binance WS-FAPI WebSocket 测试
 * 订阅连续合约 K线
 * 参考: https://developers.binance.com/docs/zh-CN/derivatives/usds-margined-futures/websocket-market-streams/Continuous-Contract-Kline-Candlestick-Streams
 *
 * 用法:
 *   node test-ws-fapi.js
 */

const WebSocket = require('ws');

console.log('===========================================');
console.log('Binance WS-FAPI WebSocket 测试');
console.log('===========================================');

// 连续合约 K线: <pair>_<contractType>@continuousKline_<interval>
const stream = 'BTCUSDT_PERPETUAL@continuousKline_1m';
const url = `wss://ws-fapi.binance.com/ws-fapi/v1/${stream}`;

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
  console.log('[<] 收到消息');

  // Binance WS-FAPI 连续合约 K线格式
  // {"e":"continuous_kline","E":1607443058651,"ps":"BTCUSDT","ct":"PERPETUAL","k":{...}}
  if (msg.e === 'continuous_kline' && msg.k) {
    msgCount++;
    const k = msg.k;
    console.log('');
    console.log('[✓] K线数据 #' + msgCount + '!');
    console.log('    交易对:', msg.ps);
    console.log('    合约类型:', msg.ct);
    console.log('    时间周期:', k.i);
    console.log('    开盘时间:', new Date(k.t).toISOString());
    console.log('    开盘:', k.o, '| 当前:', k.c);
    console.log('    最高:', k.h, '| 最低:', k.l);
    console.log('    成交量:', k.v);
    console.log('    成交笔数:', k.n);
    console.log('    收盘:', k.x ? '是' : '否');

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