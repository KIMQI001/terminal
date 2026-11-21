/**
 * 市场结构浏览器实测（可切周期）
 *
 *   node scripts/verify-structure-tf.js 1D
 *
 * 做三件事：
 *   1) 打开首页，等图表画出来
 *   2) 切换到指定周期（5m/15m/1H/4H/1D/4D）
 *   3) 扫描 canvas 像素，统计 BOS / CHoCH 结构线像素，并截图人工核对
 *
 * 结构线画在 canvas 上（StructurePrimitive），只能靠像素颜色验证：
 *   BOS 向上 #3b82f6 / BOS 向下 #ef4444 / CHoCH 向上 #22c55e / CHoCH 向下 #a855f7
 * 预测位是**实线**、已发生的事件是**虚线**，靠 alpha 混合后的近似色区分。
 */
const puppeteer = require("puppeteer");
const fs = require("fs");

const TF = process.argv[2] || "1D";
const OUT = process.argv[3] || `/tmp/structure-${TF}.png`;
const URL = process.env.ICT_URL || "http://localhost:3000/";

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath:
      process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 1050 });

  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  // 注入登录态（zustand persist → localStorage['user-storage']），否则会被重定向到 /login
  await page.evaluateOnNewDocument(
    (token) => {
      localStorage.setItem(
        "user-storage",
        JSON.stringify({
          state: {
            user: { id: 2, username: "icttest", role: "user" },
            token,
            isAuthenticated: true,
            apiConfigs: [],
            activeExchange: null,
            loading: false,
            error: null,
            isSettingsOpen: false,
          },
          version: 0,
        })
      );
    },
    process.env.ICT_TOKEN || ""
  );

  await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
  await page.waitForSelector("canvas", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 6000));

  // 切周期
  const clicked = await page.evaluate((tf) => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const target = buttons.find((b) => (b.textContent || "").trim() === tf);
    if (!target) return false;
    target.click();
    return true;
  }, TF);
  console.log(`切换周期 ${TF}:`, clicked ? "已点击" : "❌ 找不到按钮");
  await new Promise((r) => setTimeout(r, 9000));

  const report = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll("canvas"));
    let pane = null;
    for (const c of list) {
      const r = c.getBoundingClientRect();
      if (!pane || r.width * r.height > pane.width * pane.height) {
        pane = { el: c, x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    if (!pane) return { error: "no canvas" };

    const ctx = pane.el.getContext("2d");
    const { data } = ctx.getImageData(0, 0, pane.el.width, pane.el.height);

    const countNear = (r, g, b, tol = 40) => {
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const dr = data[i] - r;
        const dg = data[i + 1] - g;
        const db = data[i + 2] - b;
        if (Math.abs(dr) <= tol && Math.abs(dg) <= tol && Math.abs(db) <= tol) n++;
      }
      return n;
    };

    // 实线（预测位，alpha=1 → 纯色）与虚线（已发生，alpha=.85 → 混合色）分开统计
    const solid = (r, g, b, tol = 24) => countNear(r, g, b, tol);

    return {
      pane: { w: pane.width, h: pane.height },
      // 实线（预测位，原色）
      solidBosUp: solid(59, 130, 246),
      solidBosDown: solid(239, 68, 68),
      solidChochUp: solid(34, 197, 94),
      solidChochDown: solid(168, 85, 247),
      // 虚线（已发生事件，alpha .85 混白）
      dashBosUp: countNear(88, 148, 247),
      dashBosDown: countNear(241, 96, 96),
      dashChochUp: countNear(67, 205, 118),
      dashChochDown: countNear(181, 110, 248),
    };
  });

  const shot = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll("canvas"));
    let best = null;
    for (const c of list) {
      const r = c.getBoundingClientRect();
      if (!best || r.width * r.height > best.width * best.height) {
        best = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    return best;
  });
  if (shot && shot.width > 0) {
    await page.screenshot({
      path: OUT,
      clip: {
        x: Math.max(0, shot.x),
        y: Math.max(0, shot.y),
        width: Math.min(shot.width, 1680 - Math.max(0, shot.x)),
        height: Math.min(shot.height, 1050 - Math.max(0, shot.y)),
      },
    });
  }

  console.log("\n===== 浏览器实测", TF, "=====");
  console.log("实线(预测位)  BOS↑", report.solidBosUp, " BOS↓", report.solidBosDown,
    " CHoCH↑", report.solidChochUp, " CHoCH↓", report.solidChochDown);
  console.log("虚线(已发生)  BOS↑", report.dashBosUp, " BOS↓", report.dashBosDown,
    " CHoCH↑", report.dashChochUp, " CHoCH↓", report.dashChochDown);
  console.log("截图:", OUT);
  if (errors.length) {
    console.log("\n页面错误(前 10 条):");
    errors.slice(0, 10).forEach((e) => console.log("  -", e));
  } else {
    console.log("\n无页面错误");
  }

  await browser.close();
  fs.writeFileSync(`/tmp/structure-report-${TF}.json`, JSON.stringify(report, null, 2));
})();
