/**
 * CoinGlass 清算数据 HTTP 服务
 * 通过 Playwright 持续运行，自动获取 CoinGlass 清算数据
 * 端口 3004，提供 /api/liqmap/top 和 /health 接口
 */

const { chromium } = require('playwright');
const http = require('http');

const INJECT_SCRIPT = `
(function() {
    window.__CG_LIQ_DATA__ = {
        positions: null,
        hyperliquid: null
    };

    const originalJSONParse = JSON.parse;
    JSON.parse = function(text, ...rest) {
        const result = originalJSONParse.apply(this, [text, ...rest]);

        if (result && typeof result === 'object') {
            if (result.price !== undefined && result.list && Array.isArray(result.list)) {
                if (result.list[0]?.userId && result.list[0]?.liquidationPrice !== undefined) {
                    if (result.list[0]?.coin === 'BTC' || result.list[0]?.symbol === 'BTC') {
                        window.__CG_LIQ_DATA__.hyperliquid = result;
                    } else {
                        window.__CG_LIQ_DATA__.positions = result;
                    }
                }
            }
        }

        return result;
    };
})();
`;

// 全局浏览器实例
let browser = null;
let page = null;
let isReady = false;
let currentPrice = 68000;
let lastFetchTime = 0;
const FETCH_INTERVAL = 3 * 60 * 1000; // 3 分钟刷新一次

/**
 * 初始化浏览器
 */
async function initBrowser() {
    if (browser) return;

    console.log('[Server] 启动浏览器...');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    page = await context.newPage();

    await page.addInitScript(INJECT_SCRIPT);

    console.log('[Server] 访问 CoinGlass...');
    await page.goto('https://www.coinglass.com/zh/pro/futures/LiquidationMap?exchange=Binance&symbol=BTC', {
        waitUntil: 'networkidle',
        timeout: 45000
    });

    console.log('[Server] 等待数据加载...');
    await page.waitForTimeout(10000);

    // 获取当前价格
    const price = await page.evaluate(() => {
        const data = window.__CG_LIQ_DATA__;
        return data?.positions?.price || data?.hyperliquid?.price || 0;
    });

    if (price) {
        currentPrice = price;
        console.log(`[Server] 当前价格: $${price}`);
    }

    isReady = true;
    console.log('[Server] 就绪');
}

/**
 * 获取清算数据
 */
async function getLiquidationData(symbol, limit = 5) {
    if (!page || !isReady) {
        await initBrowser();
    }

    // 检查是否需要刷新
    const now = Date.now();
    if (now - lastFetchTime > FETCH_INTERVAL) {
        console.log('[Server] 刷新数据...');
        await refreshData();
    }

    const data = await page.evaluate(() => window.__CG_LIQ_DATA__);
    const positions = [
        ...(data?.hyperliquid?.list || []),
        ...(data?.positions?.list || [])
    ];

    if (positions.length === 0) {
        return null;
    }

    // 计算清算密集区 (0.2% 分桶)
    const bucketSize = currentPrice * 0.002;
    const longBuckets = new Map();
    const shortBuckets = new Map();

    for (const p of positions) {
        const price = p.liquidationPrice;
        const volume = p.positionUsd || 0;
        const distance = Math.abs((price - currentPrice) / currentPrice * 100);

        if (distance > 5) continue;

        const bucket = Math.round(price / bucketSize) * bucketSize;
        const bucketKey = Math.round(bucket * 100) / 100;

        if (price < currentPrice) {
            longBuckets.set(bucketKey, (longBuckets.get(bucketKey) || 0) + volume);
        } else {
            shortBuckets.set(bucketKey, (shortBuckets.get(bucketKey) || 0) + volume);
        }
    }

    const longPeaks = Array.from(longBuckets.entries())
        .map(([price, volume]) => ({
            price,
            volume,
            side: 'long',
            distance: Math.abs((price - currentPrice) / currentPrice * 100)
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, limit);

    const shortPeaks = Array.from(shortBuckets.entries())
        .map(([price, volume]) => ({
            price,
            volume,
            side: 'short',
            distance: Math.abs((price - currentPrice) / currentPrice * 100)
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, limit);

    return { longPeaks, shortPeaks };
}

/**
 * 刷新页面数据
 */
async function refreshData() {
    if (!page) return;

    try {
        // 重新访问页面刷新数据
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(5000);

        // 更新当前价格
        const price = await page.evaluate(() => {
            const data = window.__CG_LIQ_DATA__;
            return data?.positions?.price || data?.hyperliquid?.price || 0;
        });

        if (price) {
            currentPrice = price;
        }

        lastFetchTime = Date.now();
        console.log(`[Server] 数据已刷新，当前价格: $${currentPrice}`);
    } catch (err) {
        console.error('[Server] 刷新数据失败:', err.message);
    }
}

// HTTP 服务器
const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ready: isReady }));
        return;
    }

    // 兼容原有 API 路径 /api/liqmap/top
    if (url.pathname === '/api/liqmap/top') {
        const symbol = url.searchParams.get('symbol') || 'BTC';
        const limit = parseInt(url.searchParams.get('limit')) || 5;

        // 如果浏览器未初始化完成，返回错误
        if (!isReady) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Service initializing, please retry in 30 seconds' }));
            return;
        }

        try {
            const data = await getLiquidationData(symbol, limit);

            const longTop = (data?.longPeaks || []).map(l => ({
                price: l.price,
                amount: l.volume
            }));

            const shortTop = (data?.shortPeaks || []).map(sh => ({
                price: sh.price,
                amount: sh.volume
            }));

            const longTotal = longTop.reduce((s, l) => s + l.amount, 0);
            const shortTotal = shortTop.reduce((s, sh) => s + sh.amount, 0);

            const response = {
                success: true,
                data: {
                    symbol: symbol,
                    timestamp: new Date().toISOString(),
                    lastPrice: currentPrice,
                    longTop,
                    shortTop,
                    longTotal,
                    shortTotal
                }
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        } catch (err) {
            console.error('[Server] /api/liqmap/top 失败:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

const PORT = process.env.PORT || 3004;

async function main() {
    // 先启动 HTTP 服务器，立即响应
    server.listen(PORT, () => {
        console.log(`═══════════════════════════════════════`);
        console.log(`  CoinGlass 清算数据服务`);
        console.log(`  http://localhost:${PORT}/api/liqmap/top?symbol=BTC&limit=5`);
        console.log(`  http://localhost:${PORT}/health`);
        console.log(`═══════════════════════════════════════`);
        console.log('[Server] 正在初始化浏览器...');
    });

    // 后台初始化浏览器，不阻塞
    initBrowser().catch(err => {
        console.error('[Server] 浏览器初始化失败:', err.message);
    });
}

// 优雅关闭
process.on('SIGTERM', async () => {
    console.log('[Server] 关闭中...');
    if (browser) await browser.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('[Server] 关闭中...');
    if (browser) await browser.close();
    process.exit(0);
});

main().catch(console.error);