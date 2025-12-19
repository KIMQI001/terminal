/**
 * Coinglass 数据自动获取器
 * 使用 Playwright 自动执行浏览器并提取解密后的数据
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// 注入脚本 - 与插件相同的拦截逻辑
const INJECT_SCRIPT = `
(function() {
    window.__CG_DATA__ = {
        positions: null,
        liqMap: null,
        exchanges: null,
        leverageData: null,
        cumLiqData: null,
        allParsed: []
    };

    const originalJSONParse = JSON.parse;
    JSON.parse = function(text, ...rest) {
        const result = originalJSONParse.apply(this, [text, ...rest]);

        if (result && typeof result === 'object') {
            // 捕获大户持仓数据
            if (result.price !== undefined && result.list && Array.isArray(result.list)) {
                if (result.list[0]?.userId && result.list[0]?.liquidationPrice !== undefined) {
                    console.log('[Auto] 捕获到持仓数据:', result.list.length);
                    window.__CG_DATA__.positions = result;
                }
            }

            // 捕获清算地图数据
            if (result.rangeHigh !== undefined && result.rangeLow !== undefined && result.data) {
                console.log('[Auto] 捕获到清算地图数据');
                window.__CG_DATA__.liqMap = result;
            }

            // 捕获按杠杆细分的清算数据
            if (Array.isArray(result) && result[0]?.liq10x !== undefined) {
                console.log('[Auto] 捕获到杠杆细分数据:', result.length);
                window.__CG_DATA__.leverageData = result;
            }

            // 捕获累计清算数据
            if (Array.isArray(result) && result[0]?.cumLongLiq !== undefined) {
                console.log('[Auto] 捕获到累计清算数据:', result.length);
                window.__CG_DATA__.cumLiqData = result;
            }

            // 捕获交易所数据
            if (Array.isArray(result) && result[0]?.exchangeName && result[0]?.openInterest) {
                console.log('[Auto] 捕获到交易所数据:', result.length);
                window.__CG_DATA__.exchanges = result;
            }

            // 捕获所有大数组用于调试
            if (Array.isArray(result) && result.length > 50 && result.length < 5000) {
                const sample = result[0];
                if (sample && typeof sample === 'object') {
                    const keys = Object.keys(sample).slice(0, 8).join(',');
                    console.log('[Auto] 捕获数组 len=' + result.length + ' keys=' + keys);
                    window.__CG_DATA__.allParsed.push({
                        len: result.length,
                        keys: Object.keys(sample),
                        sample: sample,
                        data: result
                    });
                }
            }
        }

        return result;
    };

    console.log('[Auto] 拦截器已注入');
})();
`;

async function fetchCoinglassData(options = {}) {
    const {
        url = 'https://www.coinglass.com/zh/pro/futures/LiquidationMap?exchange=Binance&symbol=BTC',
        headless = true,
        timeout = 30000,
        outputDir = './output'
    } = options;

    console.log('🚀 启动 Coinglass 数据获取器...\n');

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });

    const page = await context.newPage();

    // 注入拦截脚本
    await page.addInitScript(INJECT_SCRIPT);

    // 监听控制台
    page.on('console', msg => {
        if (msg.text().includes('[Auto]')) {
            console.log('  ' + msg.text());
        }
    });

    console.log('📡 访问页面:', url);
    await page.goto(url, { waitUntil: 'networkidle', timeout });

    console.log('⏳ 等待数据加载...');
    await page.waitForTimeout(8000);

    // 尝试点击图表触发更多数据加载
    try {
        await page.mouse.move(600, 400);
        await page.waitForTimeout(1000);
    } catch (e) {}

    // 提取数据
    const data = await page.evaluate(() => window.__CG_DATA__);

    await browser.close();

    // 处理结果
    const result = {
        timestamp: new Date().toISOString(),
        url,
        data: {}
    };

    if (data.positions) {
        result.data.positions = data.positions;
        console.log(`\n✅ 持仓数据: ${data.positions.list?.length || 0} 条`);
    }

    if (data.liqMap) {
        result.data.liqMap = data.liqMap;
        console.log(`✅ 清算地图数据: 已获取`);
    }

    if (data.exchanges) {
        result.data.exchanges = data.exchanges;
        console.log(`✅ 交易所数据: ${data.exchanges.length} 条`);
    }

    // 保存到文件
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const filename = `coinglass_${Date.now()}.json`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(result, null, 2));
    console.log(`\n💾 数据已保存: ${filepath}`);

    return result;
}

// 获取特定页面数据的便捷函数
async function fetchHyperliquidPositions() {
    return fetchCoinglassData({
        url: 'https://www.coinglass.com/zh/pro/futures/LiquidationMap'
    });
}

async function fetchBinanceLiqMap() {
    return fetchCoinglassData({
        url: 'https://www.coinglass.com/zh/pro/futures/LiquidationMap'
    });
}

// 主函数
async function main() {
    try {
        const result = await fetchCoinglassData();

        // 打印清算地图 Top 5
        if (result.data.liqMap?.data?.[0]?.liqMapV2) {
            const liqMapV2 = result.data.liqMap.data[0].liqMapV2;
            const currentPrice = result.data.liqMap.lastPrice || 100000;

            const parsed = Object.keys(liqMapV2).map(p => ({
                price: +p,
                amount: liqMapV2[p][0][1]
            }));

            const longLiq = parsed.filter(p => p.price < currentPrice).sort((a, b) => b.amount - a.amount);
            const shortLiq = parsed.filter(p => p.price >= currentPrice).sort((a, b) => b.amount - a.amount);

            console.log(`\n📊 Binance BTC/USDT 清算地图 (当前价: $${currentPrice.toLocaleString()})`);

            console.log('\n🟢 多头清算 Top 5 (价格下跌时爆仓):');
            longLiq.slice(0, 5).forEach((p, i) => {
                console.log(`   ${i + 1}. $${p.price.toLocaleString().padEnd(8)} → $${(p.amount / 1e6).toFixed(2)}M`);
            });
            console.log(`   累计: $${(longLiq.reduce((s, p) => s + p.amount, 0) / 1e9).toFixed(2)}B`);

            console.log('\n🔴 空头清算 Top 5 (价格上涨时爆仓):');
            shortLiq.slice(0, 5).forEach((p, i) => {
                console.log(`   ${i + 1}. $${p.price.toLocaleString().padEnd(8)} → $${(p.amount / 1e6).toFixed(2)}M`);
            });
            console.log(`   累计: $${(shortLiq.reduce((s, p) => s + p.amount, 0) / 1e9).toFixed(2)}B`);
        }

        console.log('\n✨ 完成!');

    } catch (error) {
        console.error('❌ 错误:', error.message);
        process.exit(1);
    }
}

// 导出函数供外部使用
module.exports = {
    fetchCoinglassData,
    fetchHyperliquidPositions,
    fetchBinanceLiqMap
};

// 直接运行
if (require.main === module) {
    main();
}
