/**
 * kline-server WebSocket 测试脚本
 *
 * 用法:
 *   node test-kline-server-ws.js [ws-url]
 *
 * 示例:
 *   node test-kline-server-ws.js ws://localhost:3001/ws
 *   node test-kline-server-ws.js wss://guncangdashi.sbs/ws
 */

const WebSocket = require('ws');

const WS_URL = process.argv[2] || 'ws://localhost:3001/ws';
const SYMBOL = 'BTCUSDC';
const TIMEFRAME = '1m';

console.log('===========================================');
console.log('kline-server WebSocket 测试');
console.log('===========================================');
console.log(`URL: ${WS_URL}`);
console.log(`订阅: ${SYMBOL}@${TIMEFRAME}`);
console.log('');

const ws = new WebSocket(WS_URL);

let klineHistoryCount = 0;
let klineUpdateCount = 0;
const startTime = Date.now();

ws.on('open', () => {
  console.log('[✓] WebSocket 连接成功');

  // 发送订阅消息
  const subscribeMsg = {
    type: 'Subscribe',
    data: {
      symbol: SYMBOL,
      timeframe: TIMEFRAME
    }
  };

  console.log('[>] 发送订阅请求...');
  console.log('    ' + JSON.stringify(subscribeMsg));
  ws.send(JSON.stringify(subscribeMsg));
  console.log('');
});

ws.on('message', (data) => {
  const text = data.toString();
  let msg;

  try {
    msg = JSON.parse(text);
  } catch (e) {
    console.log('[!] 无法解析消息:', text.substring(0, 100));
    return;
  }

  console.log(`[<] 收到消息: type=${msg.type}`);

  if (msg.type === 'KlineHistory') {
    klineHistoryCount = msg.data?.klines?.length || 0;
    console.log(`    历史K线: ${klineHistoryCount} 根`);
    console.log(`    最新价格: ${msg.data?.klines?.[klineHistoryCount - 1]?.close || 'N/A'}`);
    console.log('');
  } else if (msg.type === 'KlineUpdate') {
    klineUpdateCount++;
    const d = msg.data;
    console.log(`    时间: ${d.time}, 开盘: ${d.open}, 当前: ${d.close}`);
    console.log(`    累计更新: ${klineUpdateCount} 次`);

    // 收到3次更新后退出
    if (klineUpdateCount >= 3) {
      console.log('');
      console.log('[✓] 测试成功! 实时更新正常');
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`[i] 历史: ${klineHistoryCount} 根, 更新: ${klineUpdateCount} 次, 耗时 ${elapsed.toFixed(1)}s`);
      ws.close();
      process.exit(0);
    }
  } else if (msg.type === 'Error') {
    console.log(`    错误: ${JSON.stringify(msg.data)}`);
  } else if (msg.type === 'Pong') {
    console.log('    心跳响应');
  } else {
    console.log(`    未知消息类型: ${JSON.stringify(msg.data || msg).substring(0, 100)}`);
  }
});

ws.on('error', (error) => {
  console.error('[✗] WebSocket 错误:', error.message);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log(`[✗] 连接关闭: code=${code}, reason=${reason || '无'}`);

  if (klineHistoryCount === 0 && klineUpdateCount === 0) {
    console.log('[✗] 没有收到任何数据');
    process.exit(1);
  }
});

// 30 秒超时
setTimeout(() => {
  console.log('');
  console.log('[i] 测试完成 (超时)');
  console.log(`[i] 历史: ${klineHistoryCount} 根, 更新: ${klineUpdateCount} 次`);
  ws.close();
  process.exit(0);
}, 30000);