const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    console.log('启动浏览器，请手动登录...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://www.coinglass.com/zh/login');

    // 等待登录成功（URL 包含 account）
    await page.waitForURL('**/account**', { timeout: 120000 });
    console.log('登录成功！');

    // 等待页面加载完成
    await page.waitForTimeout(3000);

    // 访问清算地图页面
    await page.goto('https://www.coinglass.com/pro/futures/LiquidationMap?exchange=Binance&symbol=BTC');
    await page.waitForTimeout(5000);

    // 获取所有 cookies
    const cookies = await context.cookies();
    console.log(`\n获取到 ${cookies.length} 个 cookies:`);
    for (const c of cookies) {
        console.log(`   ${c.name}`);
    }

    // 保存
    fs.writeFileSync('cookies.json', JSON.stringify(cookies, null, 2));
    console.log('\n已保存到 cookies.json');

    await browser.close();
})();
