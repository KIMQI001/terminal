const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    // 读取 Python 获取的 cookies 和 token
    const cookies = JSON.parse(fs.readFileSync('cookies.json', 'utf-8'));
    const token = fs.readFileSync('token.txt', 'utf-8').trim();

    console.log('1. 启动浏览器...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    // 添加 cookies
    console.log('2. 添加 cookies...');
    await context.addCookies(cookies);

    // 用 Authorization header 访问多个页面
    console.log('3. 访问账户页面...');
    await page.goto('https://www.coinglass.com/zh/account', {
        headers: { 'Authorization': `Bearer ${token}` },
        waitUntil: 'networkidle'
    });
    await page.waitForTimeout(3000);

    console.log('4. 访问 Pro 页面...');
    await page.goto('https://www.coinglass.com/pro', {
        headers: { 'Authorization': `Bearer ${token}` },
        waitUntil: 'networkidle'
    });
    await page.waitForTimeout(3000);

    console.log('5. 访问清算地图页面...');
    await page.goto('https://www.coinglass.com/pro/futures/LiquidationMap?exchange=Binance&symbol=BTC', {
        headers: { 'Authorization': `Bearer ${token}` },
        waitUntil: 'networkidle'
    });
    await page.waitForTimeout(5000);

    // 获取浏览器中的所有 cookies
    console.log('4. 获取 cookies...');
    const browserCookies = await context.cookies();

    console.log(`\n获取到 ${browserCookies.length} 个 cookies:`);
    for (const c of browserCookies) {
        console.log(`   ${c.name}: ${c.value.substring(0, 40)}...`);
    }

    // 保存完整 cookies
    const fullCookies = browserCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite
    }));

    fs.writeFileSync('cookies-full.json', JSON.stringify(fullCookies, null, 2));
    console.log('\n完整 cookies 已保存到 cookies-full.json');

    await browser.close();
})();
