// coinglass/fetch-with-login.js

const { chromium } = require('playwright');

async function fetchCoinglassData() {
    console.log('🚀 启动 Coinglass 抓取...\n');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    // ========== 第一步：登录 ==========
    console.log('📝 登录中...');
    await page.goto('https://www.coinglass.com/zh/login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    await page.locator('input[placeholder="邮箱"]').fill('297511521@qq.com');
    await page.waitForTimeout(300);
    await page.locator('input[type="password"]').fill('123456lzy');
    await page.waitForTimeout(300);
    await page.locator('button:has-text("登录")').nth(1).click();

    await page.waitForTimeout(5000);
    console.log('✅ 登录成功\n');

    // ========== 第二步：注入拦截脚本 ==========
    console.log('💉 注入拦截脚本...');
    await page.addInitScript(`
        window.__CG_DATA__ = {
            liqMap: null,
            positions: null,
            interceptLogs: []
        };

        const originalJSONParse = JSON.parse;
        JSON.parse = function(text, ...rest) {
            const result = originalJSONParse.apply(this, [text, ...rest]);

            if (result && typeof result === 'object') {
                // 捕获清算地图数据
                if (result.rangeHigh !== undefined && result.rangeLow !== undefined && result.data) {
                    console.log('[拦截] 捕获到 liqMap 明文数据!');
                    window.__CG_DATA__.liqMap = result;
                    window.__CG_DATA__.interceptLogs.push('liqMap: rangeHigh=' + result.rangeHigh);
                }

                // 捕获持仓数据
                if (result.price !== undefined && result.list && Array.isArray(result.list)) {
                    if (result.list[0]?.userId && result.list[0]?.liquidationPrice !== undefined) {
                        console.log('[拦截] 捕获到持仓数据: ' + result.list.length + '条');
                        window.__CG_DATA__.positions = result;
                    }
                }
            }
            return result;
        };

        // 拦截 fetch 响应
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            const response = await originalFetch.apply(this, args);
            if (args[0] && args[0].includes('liqMap')) {
                const clone = response.clone();
                clone.text().then(text => {
                    try {
                        const json = JSON.parse(text);
                        if (json.data && typeof json.data === 'string') {
                            console.log('[拦截] 捕获到加密的 liqMap API 响应, length=' + json.data.length);
                            window.__CG_DATA__.interceptLogs.push('encrypted liqMap: ' + json.data.substring(0, 50));
                        }
                    } catch(e) {}
                });
            }
            return response;
        };

        console.log('[拦截器] 已启动');
    `);

    // 监听控制台
    page.on('console', msg => {
        if (msg.text().includes('[拦截]')) {
            console.log('  ' + msg.text());
        }
    });

    // ========== 第三步：访问清算地图页面 ==========
    console.log('📄 访问清算地图页面...');
    await page.goto('https://www.coinglass.com/pro/futures/LiquidationMap?exchange=Binance&symbol=BTC', { waitUntil: 'networkidle', timeout: 30000 });

    console.log('⏳ 等待数据加载...');
    await page.waitForTimeout(30000); // 等待30秒

    // ========== 第四步：检查捕获结果 ==========
    console.log('\n📊 检查捕获结果...');
    const data = await page.evaluate(() => window.__CG_DATA__);

    console.log('\n拦截日志:');
    data.interceptLogs.forEach(log => console.log('  - ' + log));

    if (data.liqMap) {
        console.log('\n✅ 成功捕获到 liqMap 明文数据!');
        console.log('   lastPrice:', data.liqMap.lastPrice);
        console.log('   rangeHigh:', data.liqMap.rangeHigh);
        console.log('   rangeLow:', data.liqMap.rangeLow);
    } else {
        console.log('\n❌ 未捕获到 liqMap 明文数据');
    }

    if (data.positions) {
        console.log('\n✅ 成功捕获到持仓数据: ' + data.positions.list.length + '条');
    }

    // 截图保存
    await page.screenshot({ path: './output/coinglass-result.png', fullPage: true });
    console.log('\n📸 截图已保存到 ./output/coinglass-result.png');

    // 保存原始数据到文件
    if (data.liqMap) {
        require('fs').writeFileSync(
            './output/liqmap-data.json',
            JSON.stringify(data.liqMap, null, 2)
        );
        console.log('💾 数据已保存到 ./output/liqmap-data.json');
    }

    await browser.close();

    return data;
}

fetchCoinglassData()
    .then(data => {
        console.log('\n✨ 完成!');
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ 错误:', err);
        process.exit(1);
    });
