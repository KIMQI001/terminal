const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('请手动登录...');
    await page.goto('https://www.coinglass.com/zh/login');

    // 等待用户手动登录完成
    await new Promise(resolve => {
        const check = setInterval(async () => {
            if (page.url().includes('account')) {
                clearInterval(check);
                resolve();
            }
        }, 2000);
    });

    console.log('登录成功，保存 cookies...');
    const cookies = await context.cookies();
    require('fs').writeFileSync('cookies.json', JSON.stringify(cookies, null, 2));
    console.log('Cookies 已保存');

    await browser.close();
})();
