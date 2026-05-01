/**
 * 测试脚本 - 用于验证 Binance WebSocket 和 kline-server WS 连接
 *
 * 在服务器上运行:
 *   cd /path/to/terminal
 *   node scripts/test-ws.js binance      # 测试 Binance WS
 *   node scripts/test-ws.js kline-server # 测试 kline-server WS
 */

const WebSocket = require('ws');

const args = process.argv.slice(2);
const testType = args[0] || 'help';

if (testType === 'help') {
  console.log('用法: node test-ws.js [binance|kline-server]');
  console.log('');
  console.log('示例:');
  console.log('  node test-ws.js binance       # 测试 Binance WebSocket');
  console.log('  node test-ws.js kline-server  # 测试 kline-server WS');
  process.exit(0);
}

// ==================== Binance WebSocket 测试 ====================
if (testType === 'binance') {
  const SYMBOL = 'btcusdt';
  const TIMEFRAME = '1m';
  const URL = `wss://fstream.binance.com/ws/${SYMBOL}@kline_${TIMEFRAME}`;

  console.log('===========================================');
  console.log('Binance WebSocket 测试');
  console.log('===========================================');
  console.log(`URL: ${URL}`);
  console.log('');

  const ws = new WebSocket(URL);
  let count = 0;
  const startTime = Date.now();

  ws.on('open', () => {
    console.log('[✓] 连接成功，等待数据...');
  });

  ws.on('message', (data) => {
    count++;
    const msg = JSON.parse(data.toString());

    if (msg.e === 'kline') {
      const k = msg.k;
      const time = new Date(k.t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      console.log(`[${count}] ${time} | O:${k.o} H:${k.h} L:${k.l} C:${k.c} | Vol:${k.v} | 收盘:${k.x}`);

      if (count >= 3) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('');
        console.log('[✓] Binance WS 正常! 耗时:', elapsed, '秒');
        ws.close();
        process.exit(0);
      }
    }
  });

  ws.on('error', (e) => {
    console.error('[✗] 错误:', e.message);
    process.exit(1);
  });

  ws.on('close', (code, reason) => {
    if (count === 0) {
      console.log('[✗] 连接已关闭，未收到数据');
      console.log('[i] code:', code, 'reason:', reason);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.log('');
    console.log('[✗] 超时 (30秒)');
    console.log('[i] 收到消息:', count);
    ws.close();
    process.exit(1);
  }, 30000);
}

// ==================== kline-server WebSocket 测试 ====================
if (testType === 'kline-server') {
  const WS_URL = process.env.KLINE_WS_URL || 'ws://localhost:3001/ws';
  const SYMBOL = 'BTCUSDT';
  const TIMEFRAME = '1m';

  console.log('===========================================');
  console.log('kline-server WebSocket 测试');
  console.log('===========================================');
  console.log(`URL: ${WS_URL}`);
  console.log(`订阅: ${SYMBOL}@${TIMEFRAME}`);
  console.log('');

  const ws = new WebSocket(WS_URL);
  let historyCount = 0;
  let updateCount = 0;
  const startTime = Date.now();

  ws.on('open', () => {
    console.log('[✓] 连接成功，发送订阅请求...');

    const msg = {
      type: 'Subscribe',
      data: { symbol: SYMBOL, timeframe: TIMEFRAME }
    };
    console.log('[>] ' + JSON.stringify(msg));
    ws.send(JSON.stringify(msg));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log(`[<] type: ${msg.type}`);

    if (msg.type === 'KlineHistory') {
      historyCount = msg.data?.klines?.length || 0;
      const lastKline = msg.data?.klines?.[historyCount - 1];
      console.log(`    历史K线: ${historyCount} 根`);
      console.log(`    最新价格: ${lastKline?.close || 'N/A'}`);
    } else if (msg.type === 'KlineUpdate') {
      updateCount++;
      const d = msg.data;
      console.log(`    时间: ${d.time} | O:${d.open} C:${d.close} | 更新#${updateCount}`);

      if (updateCount >= 3) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('');
        console.log('[✓] kline-server WS 正常!');
        console.log('[i] 历史:', historyCount, '根, 更新:', updateCount, '次, 耗时:', elapsed, '秒');
        ws.close();
        process.exit(0);
      }
    } else if (msg.type === 'Error') {
      console.log('    错误:', JSON.stringify(msg.data));
    }
  });

  ws.on('error', (e) => {
    console.error('[✗] 错误:', e.message);
    process.exit(1);
  });

  ws.on('close', (code, reason) => {
    if (historyCount === 0 && updateCount === 0) {
      console.log('[✗] 连接关闭，未收到数据');
      console.log('[i] code:', code, 'reason:', reason);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.log('');
    console.log('[i] 测试完成 (超时)');
    console.log('[i] 历史:', historyCount, '根, 更新:', updateCount, '次');
    ws.close();
    process.exit(0);
  }, 30000);
}