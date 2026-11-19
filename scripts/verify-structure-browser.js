/**
 * 市场结构（BOS/CHoCH + HH/HL/LH/LL）浏览器实测
 *
 *   node scripts/verify-structure-browser.js
 *
 * 做三件事：
 *   1) 注入登录态，打开首页
 *   2) 扫描图表 canvas 的像素，断言 BOS / CHoCH 结构线真的画出来了
 *      （结构线现在由 StructurePrimitive 画在 canvas 上，不再是 SVG 覆盖层，
 *       所以只能靠像素颜色来验证 —— 蓝色=BOS向上 / 紫色=CHoCH向下 是两种独有配色）
 *   3) 截图图表区域，人工核对 HL/LH 标签与配色
 */
const puppeteer = require("puppeteer");
const fs = require("fs");

const TOKEN = process.env.ICT_TOKEN || "";
const URL = process.env.ICT_URL || "http://localhost:3000/";
const OUT = "/tmp/structure-check.png";

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    // puppeteer 自带的 Chrome 版本没下载，用系统 Chrome
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

  // 注入登录态（zustand persist → localStorage['user-storage']）
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
    TOKEN
  );

  await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });

  // 等图表画出来
  await page.waitForSelector("canvas", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 9000));

  const report = await page.evaluate(() => {
    // 主图 pane = 宽最大的那个 canvas
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
    const { data, width, height } = ctx.getImageData(0, 0, pane.el.width, pane.el.height);

    /**
     * 统计接近目标色的像素数量。
     * 结构线画在白色背景上、带 alpha 混合，所以按「混合后的近似色」找，
     * 容差放宽到 40，避免因为 alpha/抗锯齿一个像素都找不到。
     */
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

    // 与白底混合后的目标色：
    //   BOS 向上 #3b82f6 alpha .85 → (88,148,247)
    //   BOS 向下 #ef4444 alpha .85 → (241,96,96)
    //   CHoCH 向上 #22c55e alpha .85 → (67,205,118)
    //   CHoCH 向下 #a855f7 alpha .85 → (181,110,248)
    const bosUp = countNear(88, 148, 247);
    const bosDown = countNear(241, 96, 96);
    const chochUp = countNear(67, 205, 118);
    const chochDown = countNear(181, 110, 248);

    // SVG 覆盖层里不该再有 BOS / CHoCH 标签了（已移到 canvas primitive）
    const svgLabels = {};
    for (const svg of document.querySelectorAll("svg")) {
      for (const t of svg.querySelectorAll("text")) {
        const c = (t.textContent || "").trim();
        if (!c) continue;
        svgLabels[c] = (svgLabels[c] || 0) + 1;
      }
    }

    return {
      pane: { w: pane.width, h: pane.height, cw: pane.el.width, ch: pane.el.height },
      pixels: { bosUp, bosDown, chochUp, chochDown },
      svgLabels,
      canvasCount: list.length,
    };
  });

  // 截图图表区域（取最大的那个 canvas —— 主图）
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

  console.log("\n===== 浏览器实测 =====");
  console.log("canvas 数量:", report.canvasCount, "主图尺寸:", JSON.stringify(report.pane));
  console.log("BOS 向上(蓝)像素:", report.pixels.bosUp);
  console.log("BOS 向下(红)像素:", report.pixels.bosDown);
  console.log("CHoCH 向上(绿)像素:", report.pixels.chochUp);
  console.log("CHoCH 向下(紫)像素:", report.pixels.chochDown);
  console.log("SVG 文本统计:", JSON.stringify(report.svgLabels));
  console.log("截图:", OUT, shot ? JSON.stringify(shot) : "未截到");
  if (errors.length) {
    console.log("\n页面错误(前 10 条):");
    errors.slice(0, 10).forEach((e) => console.log("  -", e));
  } else {
    console.log("\n无页面错误");
  }

  await browser.close();
  fs.writeFileSync("/tmp/structure-report.json", JSON.stringify(report, null, 2));
})();
