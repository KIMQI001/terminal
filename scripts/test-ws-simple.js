/**
 * 简单的 WebSocket 测试
 *
 * 用法:
 *   node test-ws-simple.js [binance|kline]
 *
 * 示例:
 *   node test-ws-simple.js binance   # 测试直接连接 Binance
 *   node test-ws-simple.js kline     # 测试 kline-server
 */

const WebSocket = require('ws');

const args = process.argv.slice(2);
const testType = args[0] || 'binance';

console.log('===========================================');
console.log('WebSocket 测试');
console.log('===========================================');

if (testType === 'binance') {
  // 直接连接 Binance WebSocket
  const url = 'wss://fstream.binance.com/ws/btcusdt@kline_1m';
  console.log('测试: 直接连接 Binance');
  console.log('URL:', url);
  console.log('');

  const ws = new WebSocket(url);

  const timeout = setTimeout(() => {
    console.log('[超时] 30秒内没有收到消息');
    console.log('[可能原因] 网络无法访问 Binance WebSocket');
    ws.close();
    process.exit(1);
  }, 30000);

  ws.on('open', () => {
    console.log('[✓] 连接成功');
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.e === 'kline') {
      clearTimeout(timeout);
      console.log('[✓] 收到 K线数据!');
      console.log('    交易对:', msg.s);
      console.log('    时间:', msg.k.t);
      console.log('    开盘:', msg.k.o);
      console.log('    当前:', msg.k.c);
      console.log('');
      console.log('[成功] Binance WebSocket 正常工作');
      ws.close();
      process.exit(0);
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

} else if (testType === 'kline') {
  // 测试 kline-server
  const url = process.env.KLINE_WS_URL || 'ws://localhost:3001/ws';
  console.log('测试: kline-server');
  console.log('URL:', url);
  console.log('');

  const ws = new WebSocket(url);

  const timeout = setTimeout(() => {
    console.log('[超时] 30秒内没有收到 KlineUpdate');
    console.log('[可能原因] kline-server 未正确连接 Binance');
    ws.close();
    process.exit(1);
  }, 30000);

  ws.on('open', () => {
    console.log('[✓] 连接成功，发送订阅...');

    const msg = {
      type: 'Subscribe',
      data: { symbol: 'BTCUSDC', timeframe: '1m' }
    };
    console.log('[>] ' + JSON.stringify(msg));
    ws.send(JSON.stringify(msg));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('[<] type:', msg.type);

    if (msg.type === 'KlineHistory') {
      console.log('    历史K线:', msg.data?.klines?.length, '根');
    } else if (msg.type === 'KlineUpdate') {
      clearTimeout(timeout);
      console.log('[✓] 收到实时更新!');
      console.log('    时间:', msg.data.time);
      console.log('    开盘:', msg.data.open);
      console.log('    当前:', msg.data.close);
      console.log('');
      console.log('[成功] kline-server WebSocket 正常推送!');
      ws.close();
      process.exit(0);
    } else if (msg.type === 'Error') {
      console.log('    错误:', JSON.stringify(msg.data));
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

} else {
  console.log('未知测试类型:', testType);
  console.log('用法: node test-ws-simple.js [binance|kline]');
  process.exit(1);
}
