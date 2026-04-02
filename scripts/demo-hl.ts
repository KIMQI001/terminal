/**
 * HL 分类 Demo
 *
 * 本地验证波峰波谷 + HH/HL/LH/LL 分类流程
 *
 * 运行命令: npx ts-node scripts/demo-hl.ts
 */

// Binance K线数据接口
interface BinanceKline {
  0: number;          // Open time
  1: string;          // Open
  2: string;          // High
  3: string;          // Low
  4: string;          // Close
  5: string;          // Volume
  6: number;          // Close time
  7: string;          // Quote asset volume
  8: number;          // Number of trades
  9: string;          // Taker buy base asset volume
  10: string;         // Taker buy quote asset volume
  11: string;         // Ignore
}

// Candle 类型 (简化版)
interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// SwingPoint 类型
interface SwingPoint {
  type: "high" | "low";
  price: number;
  time: number;
  index: number;
}

// 分类类型
type SwingClassification = "HH" | "HL" | "LH" | "LL";

// 带分类的 SwingPoint
interface ClassifiedSwingPoint extends SwingPoint {
  classification: SwingClassification;
}

/**
 * 从 Binance API 获取 K线数据 (使用 curl + 代理)
 */
async function fetchKlines(
  symbol: string = "BTCUSDT",
  interval: string = "1h",
  limit: number = 500
): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  console.log(`📡 正在从 Binance 获取 ${symbol} K线数据 (${interval})...`);

  // 使用 curl 获取数据，配置代理和超时
  const curlCmd = `curl -s --proxy socks5://127.0.0.1:7890 --connect-timeout 30 "${url}"`;

  return new Promise((resolve, reject) => {
    const exec = require("child_process").exec;
    exec(curlCmd, { timeout: 60000 }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        reject(new Error(`curl failed: ${error.message}`));
        return;
      }
      if (stderr) {
        console.warn("curl stderr:", stderr);
      }

      try {
        const data: BinanceKline[] = JSON.parse(stdout);
        const candles = data.map((k) => ({
          time: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }));
        resolve(candles);
      } catch (e) {
        reject(new Error(`JSON parse failed: ${e}, stdout: ${stdout.substring(0, 200)}`));
      }
    });
  });
}

/**
 * 检测所有局部极值
 */
function detectAllPivots(
  candles: Candle[],
  leftBars: number = 2,
  rightBars: number = 2
): SwingPoint[] {
  if (candles.length < Math.max(leftBars, rightBars) + 1) return [];

  const results: SwingPoint[] = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const current = candles[i];
    const actualRightBars = Math.min(rightBars, candles.length - 1 - i);

    // 检查 Pivot High
    let isPivotHigh = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].high >= current.high) {
        isPivotHigh = false;
        break;
      }
    }
    if (isPivotHigh && actualRightBars > 0) {
      for (let j = 1; j <= actualRightBars; j++) {
        if (candles[i + j].high > current.high) {
          isPivotHigh = false;
          break;
        }
      }
    }

    if (isPivotHigh) {
      results.push({
        type: "high",
        price: current.high,
        time: current.time,
        index: i,
      });
    }

    // 检查 Pivot Low
    let isPivotLow = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].low <= current.low) {
        isPivotLow = false;
        break;
      }
    }
    if (isPivotLow && actualRightBars > 0) {
      for (let j = 1; j <= actualRightBars; j++) {
        if (candles[i + j].low < current.low) {
          isPivotLow = false;
          break;
        }
      }
    }

    if (isPivotLow) {
      results.push({
        type: "low",
        price: current.low,
        time: current.time,
        index: i,
      });
    }
  }

  return results.sort((a, b) => a.time - b.time);
}

/**
 * 对 pivots 进行 HH/HL/LH/LL 分类
 */
function classifyPivots(
  pivots: SwingPoint[],
  minSwingPercent: number = 0.5
): ClassifiedSwingPoint[] {
  if (pivots.length < 2) {
    return pivots.map((p) => ({
      ...p,
      classification: (p.type === "high" ? "LH" : "LL") as SwingClassification,
    }));
  }

  const classified: ClassifiedSwingPoint[] = [];
  let lastHighPrice: number | null = null;
  let lastLowPrice: number | null = null;
  let lastClassification: SwingClassification | null = null;

  for (const pivot of pivots) {
    let classification: SwingClassification;

    if (pivot.type === "high") {
      if (lastHighPrice === null) {
        classification = "LH";
      } else {
        const priceChange = Math.abs(pivot.price - lastHighPrice) / lastHighPrice * 100;
        if (priceChange < minSwingPercent) {
          classification = lastClassification === "HH" ? "HH" : "LH";
        } else if (pivot.price > lastHighPrice) {
          classification = "HH";
        } else {
          classification = "LH";
        }
      }
      lastHighPrice = pivot.price;
    } else {
      if (lastLowPrice === null) {
        classification = "LL";
      } else {
        const priceChange = Math.abs(pivot.price - lastLowPrice) / lastLowPrice * 100;
        if (priceChange < minSwingPercent) {
          classification = lastClassification === "HL" ? "HL" : "LL";
        } else if (pivot.price > lastLowPrice) {
          classification = "HL";
        } else {
          classification = "LL";
        }
      }
      lastLowPrice = pivot.price;
    }

    lastClassification = classification;
    classified.push({ ...pivot, classification });
  }

  return classified;
}

/**
 * 格式化时间
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 主函数
 */
async function main() {
  console.log("=".repeat(60));
  console.log("🔬 HL 分类 Demo - 波峰波谷检测与 HH/HL/LH/LL 分类");
  console.log("=".repeat(60));
  console.log();

  try {
    // 1. 获取 K 线数据
    const candles = await fetchKlines("BTCUSDT", "1h", 500);
    console.log(`✅ 获取到 ${candles.length} 根 K线`);
    console.log();

    // 2. 检测波峰波谷
    console.log("🔍 正在检测波峰波谷...");
    const pivots = detectAllPivots(candles, 2, 2);
    console.log(`✅ 检测到 ${pivots.length} 个极值点 (${pivots.filter(p => p.type === "high").length} 个高点, ${pivots.filter(p => p.type === "low").length} 个低点)`);
    console.log();

    // 3. 分类 HH/HL/LH/LL
    console.log("🏷️ 正在进行 HH/HL/LH/LL 分类...");
    const classified = classifyPivots(pivots, 0.5);
    console.log();

    // 4. 输出结果
    console.log("📊 分类结果:");
    console.log("-".repeat(60));

    const hh = classified.filter((p) => p.classification === "HH");
    const hl = classified.filter((p) => p.classification === "HL");
    const lh = classified.filter((p) => p.classification === "LH");
    const ll = classified.filter((p) => p.classification === "LL");

    console.log(`   HH (Higher High)  更高的波峰: ${hh.length} 个`);
    console.log(`   HL (Higher Low)   更高的波谷: ${hl.length} 个`);
    console.log(`   LH (Lower High)   更低的波峰: ${lh.length} 个`);
    console.log(`   LL (Lower Low)    更低的波谷: ${ll.length} 个`);
    console.log("-".repeat(60));
    console.log();

    // 详细输出最近的 20 个点
    console.log("📋 最近 20 个分类点详情:");
    console.log("-".repeat(60));
    const recent = classified.slice(-20);
    for (const p of recent) {
      const time = formatTime(p.time);
      const typeSymbol = p.type === "high" ? "▲" : "▼";
      const clsColor = p.classification === "HH" ? "🟢" :
                       p.classification === "HL" ? "🔵" :
                       p.classification === "LH" ? "🟠" : "🔴";
      console.log(`   ${time}  ${typeSymbol} ${p.price.toFixed(2)}  ${clsColor} ${p.classification}`);
    }
    console.log("-".repeat(60));
    console.log();
    console.log("✨ Demo 完成!");

  } catch (error) {
    console.error("❌ 错误:", error);
    process.exit(1);
  }
}

main();
