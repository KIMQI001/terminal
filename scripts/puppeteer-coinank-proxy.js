#!/usr/bin/env node

/**
 * CoinAnk WebSocket 代理 - Puppeteer 无头浏览器版本
 *
 * 功能：
 * - 使用 Puppeteer 启动无头 Chrome
 * - 自动从 CoinAnk 页面提取 API Key
 * - 通过 WebSocket 连接后端服务器
 * - 响应后端的数据请求
 *
 * 使用方法：
 *   node scripts/puppeteer-coinank-proxy.js
 *
 * 或使用 pm2：
 *   pm2 start scripts/puppeteer-coinank-proxy.js --name coinank-proxy
 */

const puppeteer = require('puppeteer');
const WebSocket = require('ws');

// ============================================
// 配置
// ============================================

const CONFIG = {
  // 后端 WebSocket 地址
  BACKEND_WS_URL: process.env.BACKEND_WS_URL || 'wss://guncangdashi.sbs/ws/coinank/tampermonkey',

  // CoinAnk API
  COINANK_API_BASE: 'https://api.coinank.com',
  COINANK_DEFAULT_API_KEY: process.env.COINANK_API_KEY || 'LWIzMWUtYzU0Ny1kMjk5LWI2ZDA3Yjc2MzFhYmIyZDkwM2RkfDM5ODUxNTU0MzM4MjczNDc=',

  // WebSocket 重连
  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_DELAY: 5000,

  // 心跳
  HEARTBEAT_INTERVAL: 30000,
  HEARTBEAT_TIMEOUT: 10000,

  // 页面刷新间隔（用于更新 API Key）
  PAGE_REFRESH_INTERVAL: 30 * 60 * 1000, // 30分钟

  // 调试模式
  DEBUG: process.env.DEBUG === 'true' || true,
};

// ============================================
// 日志工具
// ============================================

function log(...args) {
  if (CONFIG.DEBUG) {
    console.log(`[${new Date().toISOString()}]`, '[CoinAnk代理]', ...args);
  }
}

function error(...args) {
  console.error(`[${new Date().toISOString()}]`, '[CoinAnk代理]', ...args);
}

// ============================================
// CoinAnk 代理类
// ============================================

class CoinAnkProxy {
  constructor() {
    this.browser = null;
    this.page = null;
    this.ws = null;
    this.apiKey = CONFIG.COINANK_DEFAULT_API_KEY;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.heartbeatTimeoutTimer = null;
    this.lastPongTime = null;
    this.pageRefreshTimer = null;
  }

  // 启动代理
  async start() {
    log('═══════════════════════════════════════');
    log('🚀 CoinAnk Puppeteer 代理启动中...');
    log('═══════════════════════════════════════');

    try {
      await this.launchBrowser();
      await this.setupPage();
      this.connectWebSocket();
      this.schedulePageRefresh();

      log('═══════════════════════════════════════');
      log('✅ 代理已就绪，等待后端请求...');
      log('═══════════════════════════════════════');
    } catch (err) {
      error('❌ 启动失败:', err);
      await this.cleanup();
      process.exit(1);
    }
  }

  // 启动浏览器
  async launchBrowser() {
    log('🌐 启动无头 Chrome...');

    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
      ],
    });

    log('✅ Chrome 已启动');
  }

  // 设置页面
  async setupPage() {
    log('📄 打开 CoinAnk 页面...');

    this.page = await this.browser.newPage();

    // 设置 User-Agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 拦截请求，提取 API Key
    await this.page.setRequestInterception(true);
    this.page.on('request', (request) => {
      const headers = request.headers();
      const apiKey = headers['coinank-apikey'];

      if (apiKey && apiKey !== this.apiKey) {
        log('🔑 提取到新的 API Key:', apiKey.slice(0, 20) + '...');
        this.apiKey = apiKey;
      }

      request.continue();
    });

    // 处理页面错误
    this.page.on('error', (err) => {
      error('❌ 页面错误:', err);
    });

    this.page.on('pageerror', (err) => {
      // 忽略页面 JS 错误，不影响我们的功能
    });

    // 导航到 CoinAnk
    await this.page.goto('https://coinank.com/zh-tw/liqMap/btc', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    log('✅ 页面已加载');
    log('🔑 当前 API Key:', this.apiKey.slice(0, 20) + '...');
  }

  // 定期刷新页面以更新 API Key
  schedulePageRefresh() {
    this.pageRefreshTimer = setInterval(async () => {
      log('🔄 刷新页面以更新 API Key...');
      try {
        await this.page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        log('✅ 页面已刷新');
      } catch (err) {
        error('❌ 页面刷新失败:', err.message);
      }
    }, CONFIG.PAGE_REFRESH_INTERVAL);
  }

  // 连接 WebSocket
  connectWebSocket() {
    log('🔌 连接 WebSocket:', CONFIG.BACKEND_WS_URL);

    this.ws = new WebSocket(CONFIG.BACKEND_WS_URL);

    this.ws.on('open', () => {
      log('✅ WebSocket 已连接');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
    });

    this.ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(message);
      } catch (err) {
        error('❌ 处理消息失败:', err);
      }
    });

    this.ws.on('error', (err) => {
      error('❌ WebSocket 错误:', err.message);
    });

    this.ws.on('close', () => {
      log('🔌 WebSocket 已断开');
      this.stopHeartbeat();
      this.scheduleReconnect();
    });
  }

  // 处理消息
  async handleMessage(message) {
    log('📥 收到消息:', message.action);

    if (message.action === 'pong') {
      this.handlePong();
      return;
    }

    if (message.action === 'fetch') {
      const symbol = message.symbol || 'BTC';
      const interval = message.interval || '1d';
      const requestId = message.request_id;

      log(`🎯 执行数据请求: ${symbol} @ ${interval} (ID: ${requestId})`);

      try {
        const data = await this.fetchCoinAnkData(symbol, interval);

        const response = {
          action: 'data',
          request_id: requestId,
          symbol: symbol,
          interval: interval,
          data: data.data || data,
          success: data.success !== false,
          timestamp: new Date().toISOString(),
        };

        this.ws.send(JSON.stringify(response));
        log(`✅ 数据已发送: ${symbol} (ID: ${requestId})`);
      } catch (err) {
        error(`❌ 请求失败: ${err.message} (ID: ${requestId})`);

        const response = {
          action: 'error',
          request_id: requestId,
          symbol: symbol,
          error: err.message,
          success: false,
          timestamp: new Date().toISOString(),
        };

        this.ws.send(JSON.stringify(response));
      }
    }
  }

  // 请求 CoinAnk API
  async fetchCoinAnkData(symbol, interval) {
    const url = `${CONFIG.COINANK_API_BASE}/api/liqMap/getAggLiqMap?baseCoin=${symbol}&interval=${interval}`;

    log(`📡 请求 CoinAnk API: ${symbol} @ ${interval}`);

    const response = await fetch(url, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'client': 'web',
        'coinank-apikey': this.apiKey,
        'token': '',
        'web-version': '102',
        'Referer': 'https://coinank.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    log(`✅ API 响应成功: ${symbol}`);

    return data;
  }

  // 心跳管理
  startHeartbeat() {
    this.stopHeartbeat();
    this.lastPongTime = Date.now();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        log('💓 发送心跳 ping...');
        this.ws.send(JSON.stringify({ action: 'ping' }));

        this.heartbeatTimeoutTimer = setTimeout(() => {
          const timeSinceLastPong = Date.now() - this.lastPongTime;
          if (timeSinceLastPong > CONFIG.HEARTBEAT_TIMEOUT) {
            error(`💔 心跳超时，主动断开重连...`);
            this.ws.close();
          }
        }, CONFIG.HEARTBEAT_TIMEOUT);
      }
    }, CONFIG.HEARTBEAT_INTERVAL);

    log('💓 心跳检测已启动');
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  handlePong() {
    this.lastPongTime = Date.now();
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
    log('💓 收到心跳 pong');
  }

  // 重连调度
  scheduleReconnect() {
    if (this.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
      error('❌ 已达到最大重连次数，退出程序');
      this.cleanup();
      process.exit(1);
    }

    this.reconnectAttempts++;
    log(`🔄 ${CONFIG.RECONNECT_DELAY / 1000}秒后尝试重连 (${this.reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})...`);

    setTimeout(() => {
      this.connectWebSocket();
    }, CONFIG.RECONNECT_DELAY);
  }

  // 清理资源
  async cleanup() {
    log('🧹 清理资源...');

    this.stopHeartbeat();

    if (this.pageRefreshTimer) {
      clearInterval(this.pageRefreshTimer);
    }

    if (this.ws) {
      this.ws.close();
    }

    if (this.browser) {
      await this.browser.close();
    }

    log('✅ 资源已清理');
  }
}

// ============================================
// 主程序
// ============================================

const proxy = new CoinAnkProxy();

// 优雅退出
process.on('SIGINT', async () => {
  log('📴 收到 SIGINT 信号，正在退出...');
  await proxy.cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('📴 收到 SIGTERM 信号，正在退出...');
  await proxy.cleanup();
  process.exit(0);
});

// 未捕获的异常
process.on('uncaughtException', (err) => {
  error('❌ 未捕获的异常:', err);
});

process.on('unhandledRejection', (reason) => {
  error('❌ 未处理的 Promise 拒绝:', reason);
});

// 启动
proxy.start();
