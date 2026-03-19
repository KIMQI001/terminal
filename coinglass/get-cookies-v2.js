const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    const cookies = JSON.parse(fs.readFileSync('cookies.json', 'utf-8'));
    const token = fs.readFileSync('token.txt', 'utf-8').trim();

    console.log('Token:', token.substring(0, 20) + '...');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    await context.addCookies(cookies);

    const page = await context.newPage();

    // 用 Authorization header 访问页面
    await page.goto('https://www.coinglass.com/pro/futures/LiquidationMap?exchange=Binance&symbol=BTC', {
        headers: { 'Authorization': `Bearer ${token}` },
        waitUntil: 'networkidle'
    });

    // 等待更长时间，让 JS 执行
    console.log('等待页面加载...');
    await page.waitForTimeout(15000);

    // 尝试点击一些元素触发 JS
    console.log('尝试触发 JS...');
    await page.click('body').catch(() => {});

    // 再等待
    await page.waitForTimeout(5000);

    // 获取 cookies
    const finalCookies = await context.cookies();
    console.log(`\n获取到 ${finalCookies.length} 个 cookies:`);
    for (const c of finalCookies) {
        console.log(`   ${c.name}`);
    }

    // 保存
    fs.writeFileSync('cookies-full.json', JSON.stringify(finalCookies, null, 2));

    await browser.close();
})();
