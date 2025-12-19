/**
 * Coinglass 清算地图数据服务
 * 定时抓取 Coinglass 数据，提供 API 接口
 */

const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = 3004;

// 内存存储最新数据（目前只支持 BTC）
const dataStore = {
    BTC: null
};

// 抓取状态
let isFetching = false;
let lastFetchTime = null;

// 注入脚本
const INJECT_SCRIPT = `
(function() {
    window.__CG_DATA__ = { liqMap: null };
    const originalJSONParse = JSON.parse;
    JSON.parse = function(text, ...rest) {
        const result = originalJSONParse.apply(this, [text, ...rest]);
        if (result && typeof result === 'object') {
            if (result.rangeHigh !== undefined && result.rangeLow !== undefined && result.data) {
                window.__CG_DATA__.liqMap = result;
            }
        }
        return result;
    };
})();
`;

// 抓取单个币种数据
async function fetchSymbol(symbol) {
    const url = `https://www.coinglass.com/zh/pro/futures/LiquidationMap?exchange=Binance&symbol=${symbol}`;
    console.log(`[Fetch] 抓取 ${symbol}...`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });

    const page = await context.newPage();
    await page.addInitScript(INJECT_SCRIPT);

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(5000);

        const data = await page.evaluate(() => window.__CG_DATA__);
        await browser.close();

        if (!data.liqMap?.data?.[0]?.liqMapV2) {
            console.log(`[Fetch] ${symbol} 无数据`);
            return null;
        }

        const liqMapV2 = data.liqMap.data[0].liqMapV2;
        const lastPrice = data.liqMap.lastPrice || 0;

        // 解析数据
        const parsed = Object.keys(liqMapV2).map(p => ({
            price: +p,
            amount: liqMapV2[p][0][1]
        }));

        const longLiq = parsed.filter(p => p.price < lastPrice).sort((a, b) => b.amount - a.amount);
        const shortLiq = parsed.filter(p => p.price >= lastPrice).sort((a, b) => b.amount - a.amount);

        const result = {
            symbol,
            lastPrice,
            timestamp: new Date().toISOString(),
            longLiq,
            shortLiq,
            longTotal: longLiq.reduce((s, p) => s + p.amount, 0),
            shortTotal: shortLiq.reduce((s, p) => s + p.amount, 0)
        };

        console.log(`[Fetch] ${symbol} 完成: 当前价 ${lastPrice}, 多头 ${(result.longTotal / 1e9).toFixed(2)}B, 空头 ${(result.shortTotal / 1e9).toFixed(2)}B`);
        return result;

    } catch (error) {
        await browser.close();
        console.error(`[Fetch] ${symbol} 错误:`, error.message);
        return null;
    }
}

// 抓取所有币种
async function fetchAll() {
    if (isFetching) {
        console.log('[Fetch] 正在抓取中，跳过...');
        return;
    }

    isFetching = true;
    console.log('\n[Fetch] 开始抓取 ' + new Date().toISOString());

    for (const symbol of ['BTC']) {
        const data = await fetchSymbol(symbol);
        if (data) {
            dataStore[symbol] = data;
        }
    }

    lastFetchTime = new Date().toISOString();
    isFetching = false;
    console.log('[Fetch] 抓取完成\n');
}

// API: 获取清算地图数据
app.get('/api/liqmap', (req, res) => {
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    const data = dataStore[symbol];

    if (!data) {
        return res.json({ success: false, error: '数据未就绪', lastFetch: lastFetchTime });
    }

    res.json({ success: true, data });
});

// API: 获取 Top N
app.get('/api/liqmap/top', (req, res) => {
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const data = dataStore[symbol];

    if (!data) {
        return res.json({ success: false, error: '数据未就绪' });
    }

    res.json({
        success: true,
        data: {
            symbol: data.symbol,
            lastPrice: data.lastPrice,
            timestamp: data.timestamp,
            longTop: data.longLiq.slice(0, limit),
            shortTop: data.shortLiq.slice(0, limit),
            longTotal: data.longTotal,
            shortTotal: data.shortTotal
        }
    });
});

// API: 健康检查
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        lastFetch: lastFetchTime,
        isFetching,
        symbols: Object.keys(dataStore).filter(k => dataStore[k] !== null)
    });
});

// 图表页面
app.get('/chart', (req, res) => {
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    const data = dataStore[symbol];

    if (!data) {
        return res.send('<html><body style="background:#1a1a1a;color:#fff;font-family:monospace;padding:20px;">数据未就绪，请稍后刷新</body></html>');
    }

    // 生成柱状图
    const maxAmount = Math.max(
        ...data.longLiq.slice(0, 30).map(p => p.amount),
        ...data.shortLiq.slice(0, 30).map(p => p.amount)
    );

    // 合并并按价格排序（从高到低）
    const priceRange = data.lastPrice * 0.1;
    const minPrice = data.lastPrice - priceRange;
    const maxPrice = data.lastPrice + priceRange;

    const allPrices = [
        ...data.shortLiq.filter(p => p.price <= maxPrice).map(p => ({ ...p, type: 'short' })),
        ...data.longLiq.filter(p => p.price >= minPrice).map(p => ({ ...p, type: 'long' }))
    ].sort((a, b) => b.price - a.price);

    let barsHtml = '';
    for (const item of allPrices) {
        const pct = (item.amount / maxAmount * 100).toFixed(1);
        const isCurrent = Math.abs(item.price - data.lastPrice) < 100;
        const bgStyle = isCurrent ? 'background:#444;' : '';
        const barColor = item.type === 'short' ? '#ff9800' : '#1e88e5';

        barsHtml += `<div class="row" style="${bgStyle}"><div class="price">${item.price.toFixed(0)}</div><div class="bars"><div class="bar" style="width:${pct}%;background:${barColor};"></div></div></div>`;
    }

    // Top5
    const longTop5 = data.longLiq.slice(0, 5).map(p => `<div>${p.price.toFixed(0)} ${(p.amount / 1e6).toFixed(0)}M</div>`).join('');
    const shortTop5 = data.shortLiq.slice(0, 5).map(p => `<div>${p.price.toFixed(0)} ${(p.amount / 1e6).toFixed(0)}M</div>`).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Coinglass ${symbol} 清算地图</title>
    <style>
        body { font-family: monospace; background: #1a1a1a; color: #fff; padding: 8px; margin: 0; }
        h1 { font-size: 13px; margin: 0 0 4px 0; }
        .info { color: #888; font-size: 10px; margin-bottom: 8px; }
        .chart { max-width: 600px; }
        .row { display: flex; align-items: center; height: 8px; }
        .price { width: 50px; text-align: right; padding-right: 4px; font-size: 9px; color: #666; }
        .bars { width: 400px; height: 6px; background: #222; }
        .bar { height: 100%; }
        .legend { margin: 8px 0; font-size: 10px; }
        .legend .short-label { color: #ffcc80; margin-right: 15px; }
        .legend .long-label { color: #64b5f6; }
        .stats { margin-top: 6px; font-size: 10px; color: #666; }
        a { color: #4fc3f7; }
        .top-inline { display: flex; gap: 15px; margin-left: 15px; }
        .top-box { font-size: 9px; }
        .top-box.long { color: #64b5f6; }
        .top-box.short { color: #ffcc80; }
        .top-title { font-size: 8px; color: #888; margin-bottom: 2px; }
    </style>
</head>
<body>
    <h1>Coinglass ${symbol} 清算地图</h1>
    <div class="info">
        当前价: ${data.lastPrice.toFixed(2)} | 更新: ${data.timestamp} | <a href="/chart?symbol=${symbol}">刷新</a>
    </div>
    <div class="legend">
        <span class="short-label">橙 = 空头清算</span>
        <span class="long-label">蓝 = 多头清算</span>
    </div>
    <div style="display:flex;">
        <div class="chart">${barsHtml}</div>
        <div class="top-inline">
            <div class="top-box long"><div class="top-title">Long Top5</div>${longTop5}</div>
            <div class="top-box short"><div class="top-title">Short Top5</div>${shortTop5}</div>
        </div>
    </div>
    <div class="stats">
        多头: ${(data.longTotal / 1e9).toFixed(2)}B | 空头: ${(data.shortTotal / 1e9).toFixed(2)}B |
        <a href="/chart?symbol=BTC">BTC</a>
    </div>
</body>
</html>`;

    res.send(html);
});

// 启动服务
app.listen(PORT, () => {
    console.log(`Coinglass 服务启动: http://127.0.0.1:${PORT}`);
    console.log(`  /api/liqmap?symbol=BTC - 获取清算地图`);
    console.log(`  /api/liqmap/top?symbol=BTC&limit=10 - 获取 Top N`);
    console.log(`  /chart?symbol=BTC - 图表页面`);
    console.log(`  /health - 健康检查\n`);

    // 启动时立即抓取
    fetchAll();

    // 每 3 分钟抓取一次
    setInterval(fetchAll, 3 * 60 * 1000);
});
