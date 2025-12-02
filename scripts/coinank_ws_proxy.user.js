// ==UserScript==
// @name         CoinAnk WebSocket 代理 (推荐)
// @namespace    http://tampermonkey.net/
// @version      3.1.0
// @description  通过 WebSocket 连接后端，作为 CoinAnk API 代理
// @author       ICT Trading System
// @match        https://coinank.com/*
// @match        https://www.coinank.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      api.coinank.com
// @connect      guncangdashi.sbs
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    console.log('═══════════════════════════════════════');
    console.log('🚀 CoinAnk WebSocket 代理已启动');
    console.log('═══════════════════════════════════════');

    // ============================================
    // 配置区域
    // ============================================

    // 🆕 支持本地和远程连接
    // 本地开发: ws://localhost:3001/ws/coinank/tampermonkey
    // 生产环境: wss://guncangdashi.sbs/ws/coinank/tampermonkey
    const BACKEND_WS_URL = GM_getValue('BACKEND_WS_URL', 'wss://guncangdashi.sbs/ws/coinank/tampermonkey');
    const DEBUG = GM_getValue('DEBUG', true);

    // CoinAnk API 配置
    const COINANK_API_BASE = 'https://api.coinank.com';
    let COINANK_APIKEY = GM_getValue('COINANK_APIKEY', 'LWIzMWUtYzU0Ny1kMjk5LWI2ZDA3Yjc2MzFhYmIyZDkwM2RkfDM5ODUxNTU0MzM4MjczNDc=');
    let apiKeyExtracted = false;

    // 动态提取 API Key
    function setupApiKeyExtractor() {
        log('🔍 设置 API Key 提取器...');

        // 拦截 fetch
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            const options = args[1] || {};

            // 检查是否是 CoinAnk API 请求
            if (url && url.includes('api.coinank.com/api')) {
                const headers = options.headers || {};

                // 提取 API Key
                const apiKey = headers['coinank-apikey'] ||
                               headers['Coinank-Apikey'] ||
                               headers['apikey'];

                if (apiKey && apiKey !== COINANK_APIKEY) {
                    log('🎉 从页面请求中提取到新的 API Key!');
                    log('🔑 新 Key:', apiKey.substring(0, 20) + '...');
                    COINANK_APIKEY = apiKey;
                    GM_setValue('COINANK_APIKEY', apiKey);
                    apiKeyExtracted = true;
                }
            }

            return originalFetch.apply(this, args);
        };

        // 拦截 XMLHttpRequest
        const originalXHR = window.XMLHttpRequest;
        const OriginalXHROpen = originalXHR.prototype.open;
        const OriginalXHRSetRequestHeader = originalXHR.prototype.setRequestHeader;

        originalXHR.prototype.open = function(method, url) {
            this._url = url;
            return OriginalXHROpen.apply(this, arguments);
        };

        originalXHR.prototype.setRequestHeader = function(header, value) {
            if (this._url && this._url.includes('api.coinank.com/api')) {
                if (header.toLowerCase() === 'coinank-apikey' && value !== COINANK_APIKEY) {
                    log('🎉 从 XHR 请求中提取到新的 API Key!');
                    log('🔑 新 Key:', value.substring(0, 20) + '...');
                    COINANK_APIKEY = value;
                    GM_setValue('COINANK_APIKEY', value);
                    apiKeyExtracted = true;
                }
            }
            return OriginalXHRSetRequestHeader.apply(this, arguments);
        };

        log('✅ API Key 提取器已设置');
    }

    // WebSocket 连接
    let ws = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const RECONNECT_DELAY = 3000; // 3秒

    // ============================================
    // 工具函数
    // ============================================

    function log(...args) {
        if (DEBUG) {
            console.log('[CoinAnk代理]', ...args);
        }
    }

    function error(...args) {
        console.error('[CoinAnk代理]', ...args);
    }

    // ============================================
    // CoinAnk API 请求函数
    // ============================================

    async function fetchCoinAnkData(symbol, interval = '1d') {
        // 使用聚合 API（包含多个交易所，Binance 数据最多）
        const url = `${COINANK_API_BASE}/api/liqMap/getAggLiqMap?baseCoin=${symbol}&interval=${interval}`;

        log(`📡 请求 CoinAnk 聚合 API: ${symbol} @ ${interval}`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: {
                    'accept': 'application/json, text/plain, */*',
                    'client': 'web',
                    'coinank-apikey': COINANK_APIKEY,
                    'token': '',
                    'web-version': '102',
                    'Referer': 'https://coinank.com/',
                    'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
                    'sec-ch-ua-mobile': '?1',
                    'sec-ch-ua-platform': '"Android"'
                },
                timeout: 10000,
                onload: function(response) {
                    if (response.status === 200) {
                        try {
                            const data = JSON.parse(response.responseText);
                            log(`✅ CoinAnk API 响应成功: ${symbol}`);
                            log(`📊 响应结构:`, {
                                success: data.success,
                                code: data.code,
                                hasData: !!data.data,
                                dataKeys: data.data ? Object.keys(data.data).slice(0, 5) : []
                            });

                            if (data.success) {
                                log(`✅ API 返回成功`);
                            } else {
                                log(`⚠️ API 返回 success: false, code: ${data.code}, msg: ${data.msg}`);
                            }

                            resolve(data);
                        } catch (e) {
                            error('❌ 解析响应失败:', e);
                            reject(e);
                        }
                    } else {
                        error(`❌ CoinAnk API 错误: ${response.status}`);
                        error(`❌ 响应内容:`, response.responseText.substring(0, 200));
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: function(err) {
                    error('❌ 请求失败:', err);
                    reject(err);
                },
                ontimeout: function() {
                    error('❌ 请求超时');
                    reject(new Error('Timeout'));
                }
            });
        });
    }

    // ============================================
    // WebSocket 连接管理
    // ============================================

    function connectWebSocket() {
        log('🔌 连接 WebSocket:', BACKEND_WS_URL);

        ws = new WebSocket(BACKEND_WS_URL);

        ws.onopen = function() {
            log('✅ WebSocket 已连接');
            log('═══════════════════════════════════════');
            log('🎉 连接成功! 中转服务已就绪');
            log('═══════════════════════════════════════');
            reconnectAttempts = 0;

            // 发送心跳
            setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ action: 'ping' }));
                }
            }, 30000);
        };

        ws.onmessage = async function(event) {
            try {
                const message = JSON.parse(event.data);
                log('📥 收到服务器消息:', message.action);

                if (message.action === 'fetch') {
                    // 后端请求数据
                    const symbol = message.symbol || 'BTC';
                    const interval = message.interval || '1d';
                    const requestId = message.request_id;

                    log(`🎯 执行数据请求: ${symbol} @ ${interval}`);

                    try {
                        // 请求 CoinAnk API
                        const data = await fetchCoinAnkData(symbol, interval);

                        // 发送响应给后端
                        const response = {
                            action: 'data',
                            request_id: requestId,
                            symbol: symbol,
                            interval: interval,
                            data: data.data || data,
                            success: data.success !== false,
                            timestamp: new Date().toISOString()
                        };

                        // 详细日志
                        log(`📊 原始 CoinAnk 响应:`, {
                            success: data.success,
                            successType: typeof data.success,
                            code: data.code,
                            hasData: !!data.data
                        });
                        log(`📊 发送到后端的 success:`, response.success, `(类型: ${typeof response.success})`);
                        log(`📦 响应预览:`, JSON.stringify(response).substring(0, 300) + '...');

                        ws.send(JSON.stringify(response));
                        log(`✅ 数据已发送到后端: ${symbol}`);

                    } catch (err) {
                        // 发送错误给后端
                        error(`❌ 请求失败: ${err.message}`);

                        const response = {
                            action: 'error',
                            request_id: requestId,
                            symbol: symbol,
                            error: err.message,
                            success: false,
                            timestamp: new Date().toISOString()
                        };

                        ws.send(JSON.stringify(response));
                    }
                }

            } catch (e) {
                error('❌ 处理消息失败:', e);
            }
        };

        ws.onerror = function(event) {
            error('❌ WebSocket 错误:', event);
        };

        ws.onclose = function() {
            log('🔌 WebSocket 已断开');

            // 自动重连
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                log(`🔄 ${RECONNECT_DELAY/1000}秒后尝试重连 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                setTimeout(connectWebSocket, RECONNECT_DELAY);
            } else {
                error('❌ 已达到最大重连次数，请刷新页面或检查后端服务');
            }
        };
    }

    // ============================================
    // 用户配置菜单
    // ============================================

    GM_registerMenuCommand('⚙️ 设置 WebSocket 地址', function() {
        const choice = prompt(
            '请选择连接模式:\n\n' +
            '1. 生产环境 (guncangdashi.sbs)\n' +
            '2. 本地开发 (localhost:3001)\n' +
            '3. 自定义地址\n\n' +
            '当前地址: ' + BACKEND_WS_URL + '\n\n' +
            '输入数字 (1-3):',
            '1'
        );

        let newUrl = null;
        if (choice === '1') {
            newUrl = 'wss://guncangdashi.sbs/ws/coinank/tampermonkey';
        } else if (choice === '2') {
            newUrl = 'ws://localhost:3001/ws/coinank/tampermonkey';
        } else if (choice === '3') {
            newUrl = prompt('请输入完整的 WebSocket 地址:', BACKEND_WS_URL);
        }

        if (newUrl && newUrl !== BACKEND_WS_URL) {
            GM_setValue('BACKEND_WS_URL', newUrl);
            alert('✅ WebSocket 地址已更新\n\n' +
                  '新地址: ' + newUrl + '\n\n' +
                  '请刷新页面生效！');
        }
    });

    GM_registerMenuCommand('🐛 切换调试模式', function() {
        const currentDebug = GM_getValue('DEBUG', true);
        GM_setValue('DEBUG', !currentDebug);
        alert('调试模式: ' + (!currentDebug ? '已启用' : '已禁用') + '\n请刷新页面生效');
    });

    GM_registerMenuCommand('🔄 重新连接', function() {
        log('🔄 手动重新连接...');
        reconnectAttempts = 0;
        if (ws) {
            ws.close();
        }
        setTimeout(connectWebSocket, 500);
    });

    GM_registerMenuCommand('🔑 手动设置 API Key', function() {
        const newKey = prompt('请输入 CoinAnk API Key:\n\n（提示：在 CoinAnk 页面的 Network 标签中找到 coinank-apikey 请求头）', COINANK_APIKEY);
        if (newKey && newKey !== COINANK_APIKEY) {
            COINANK_APIKEY = newKey;
            GM_setValue('COINANK_APIKEY', newKey);
            alert('✅ API Key 已更新\n\n新 Key 前20位: ' + newKey.substring(0, 20) + '...');
        }
    });

    GM_registerMenuCommand('🧪 测试 API 请求', async function() {
        log('🧪 测试 CoinAnk API...');
        log('🔑 当前使用的 API Key:', COINANK_APIKEY.substring(0, 20) + '...');
        try {
            const data = await fetchCoinAnkData('BTC', '1d');
            if (data.success !== false) {
                alert('✅ API 测试成功！\n\n' +
                      '数据结构:\n' +
                      JSON.stringify(data, null, 2).substring(0, 500));
            } else {
                alert('❌ API 返回错误\n\n' +
                      'Code: ' + data.code + '\n' +
                      'Message: ' + data.msg + '\n\n' +
                      '提示：可能需要更新 API Key\n' +
                      '使用 "🔑 手动设置 API Key" 功能更新');
            }
        } catch (err) {
            alert('❌ API 测试失败\n\n' +
                  err.message + '\n\n' +
                  '提示：请检查 API Key 是否正确\n' +
                  '使用 "🔑 手动设置 API Key" 功能更新');
        }
    });

    // ============================================
    // 启动
    // ============================================

    log('═══════════════════════════════════════');
    log('📡 后端 WebSocket:', BACKEND_WS_URL);
    log('🔑 当前 API Key:', COINANK_APIKEY.substring(0, 20) + '...');
    log('🌐 当前页面:', window.location.href);
    log('═══════════════════════════════════════');

    // 立即设置 API Key 提取器（尽早拦截页面请求）
    setupApiKeyExtractor();

    // 等待页面完全加载后连接
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            connectWebSocket();
        });
    } else {
        connectWebSocket();
    }

    // 5秒后检查是否提取到新 Key
    setTimeout(() => {
        if (apiKeyExtracted) {
            log('🎉 已自动更新 API Key!');
            log('🔑 新 Key:', COINANK_APIKEY.substring(0, 20) + '...');
        } else {
            log('💡 未检测到新 API Key，使用默认 Key');
        }
    }, 5000);

})();
