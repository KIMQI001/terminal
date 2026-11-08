import { describe, it, expect } from "vitest";
import {
  collectPriceCandidates,
  mergePriceLevels,
  computePriceBand,
  type PriceBandLevel,
} from "./priceBand";
import type { Candle } from "@/types/chart";

const mk = (time: number, open: number, high: number, low: number, close: number): Candle => ({
  time,
  open,
  high,
  low,
  close,
});

describe("collectPriceCandidates", () => {
  it("收录 open / close,阴K 额外收录 low,阳K 额外收录 high,十字星不收 high/low", () => {
    const candles: Candle[] = [
      mk(1, 100, 110, 90, 108), // 阳: open 100, close 108, high 110
      mk(2, 108, 112, 95, 100), // 阴: open 108, close 100, low 95
      mk(3, 100, 105, 95, 100), // 十字星: open 100, close 100
    ];
    const cands = collectPriceCandidates(candles);
    const byKind = (k: string) => cands.filter((c) => c.kind === k).map((c) => c.price);

    expect(byKind("open")).toEqual([100, 108, 100]);
    expect(byKind("close")).toEqual([108, 100, 100]);
    expect(byKind("high")).toEqual([110]); // 只有阳K 收 high,十字星不收
    expect(byKind("low")).toEqual([95]);
  });

  it("十字星不收录 high / low", () => {
    const cands = collectPriceCandidates([mk(1, 100, 110, 90, 100)]);
    expect(cands.some((c) => c.kind === "high")).toBe(false);
    expect(cands.some((c) => c.kind === "low")).toBe(false);
    expect(cands).toHaveLength(2); // 只有 open + close
  });

  it("忽略非法价格(0 / NaN / 负数)", () => {
    const cands = collectPriceCandidates([
      { time: 1, open: 0, high: 10, low: 0, close: 0 },
      { time: 2, open: 100, high: 110, low: 90, close: 105 },
    ]);
    expect(cands.every((c) => c.price > 0)).toBe(true);
    expect(cands).toHaveLength(3); // 只有第二根的 open/close/high
  });
});

describe("mergePriceLevels", () => {
  it("容差内的价位合并成一个簇,触及次数累加", () => {
    const cands = [
      { price: 100, kind: "open" as const, time: 1 },
      { price: 100.05, kind: "close" as const, time: 2 },
      { price: 100.02, kind: "high" as const, time: 3 },
      { price: 200, kind: "open" as const, time: 4 },
    ];
    const clusters = mergePriceLevels(cands, 1); // 容差 1
    expect(clusters).toHaveLength(2);
    expect(clusters[0].touches).toBe(3);
    expect(clusters[0].price).toBeCloseTo((100 + 100.05 + 100.02) / 3, 6);
    expect(clusters[1].price).toBe(200);
  });

  it("固定窗口:不会链式扩散(中间断档就分簇)", () => {
    const cands = [
      { price: 100, kind: "open" as const, time: 1 },
      { price: 100.9, kind: "open" as const, time: 2 },
      { price: 101.8, kind: "open" as const, time: 3 },
    ];
    const clusters = mergePriceLevels(cands, 1);
    // 100 与 100.9 同簇(差 0.9 <= 1);101.8 与簇起点 100 差 1.8 > 1 → 新簇
    expect(clusters).toHaveLength(2);
    expect(clusters[0].touches).toBe(2);
    expect(clusters[1].touches).toBe(1);
  });
});

describe("computePriceBand", () => {
  // 现价 100,上下各造出 8 个价位(间隔 10),验证只取最近 5 个
  // 同一价位的 open/close/low(或 high)彼此相差 0.4,应被容差合并成一个簇
  const build = (): Candle[] => {
    const candles: Candle[] = [];
    let t = 1;
    // 下方 8 个价位: 90, 80, 70, 60, 50, 40, 30, 20(阴K 的 low)
    for (let i = 0; i < 8; i++) {
      const low = 90 - i * 10;
      candles.push(mk(t++, low + 0.4, low + 0.5, low, low + 0.2)); // 阴K: low = low
    }
    // 上方 8 个价位: 110, 120, ... 180(阳K 的 high)
    for (let i = 0; i < 8; i++) {
      const high = 110 + i * 10;
      candles.push(mk(t++, high - 0.4, high, high - 0.5, high - 0.2)); // 阳K: high = high
    }
    return candles;
  };
  // 容差 1%(price 100 → 1 点),簇内差 0.4 合并,相邻簇差 10 分开
  const TOL = 0.01;

  it("取现价上方 5 个阻力(升序)和下方 5 个支撑(降序)", () => {
    const band = computePriceBand(build(), 100, { halfWidth: 200, mergeTolerance: TOL });
    expect(band.resistances).toHaveLength(5);
    expect(band.supports).toHaveLength(5);

    const r = band.resistances.map((x) => x.price);
    const s = band.supports.map((x) => x.price);
    expect(r).toEqual([...r].sort((a, b) => a - b)); // 升序
    expect(s).toEqual([...s].sort((a, b) => b - a)); // 降序
    expect(r[0]).toBeCloseTo(109.8, 6); // 最近阻力(high 110 + open 109.6 + close 109.8 的均值)
    expect(s[0]).toBeCloseTo(90.2, 6); // 最近支撑(low 90 + open 90.4 + close 90.2 的均值)
    expect(r[4]).toBeCloseTo(149.8, 6); // 第 5 个阻力
    expect(s[4]).toBeCloseTo(50.2, 6); // 第 5 个支撑
  });

  it("同一价位的 open/close/low 合并成一个簇,触及次数为 3", () => {
    const band = computePriceBand(build(), 100, { mergeTolerance: TOL });
    expect(band.resistances[0].touches).toBe(3);
    expect(band.resistances[0].price).toBeCloseTo(109.8, 6);
    expect(band.resistances[0].kinds.sort()).toEqual(["close", "high", "open"]);
  });

  it("每个价位形成 ±halfWidth 的价格带(默认 ±200 → 400 点宽)", () => {
    const band = computePriceBand(build(), 100, { mergeTolerance: TOL });
    expect(band.width).toBe(400);
    for (const lvl of [...band.resistances, ...band.supports]) {
      expect(lvl.upper - lvl.lower).toBeCloseTo(400, 6);
      expect(lvl.upper).toBeCloseTo(lvl.price + 200, 6);
      expect(lvl.lower).toBeCloseTo(lvl.price - 200, 6);
    }
  });

  it("halfWidth 可配", () => {
    const band = computePriceBand(build(), 100, { halfWidth: 50, mergeTolerance: TOL });
    expect(band.width).toBe(100);
    expect(band.resistances[0].upper).toBeCloseTo(band.resistances[0].price + 50, 6);
  });

  it("价位不足时返回实际数量,不做补齐", () => {
    const few: Candle[] = [mk(1, 100, 101, 99, 100.5), mk(2, 100.5, 102, 99.5, 100)];
    const band = computePriceBand(few, 100, { mergeTolerance: 0.0001 });
    const total = band.resistances.length + band.supports.length;
    expect(total).toBeLessThan(10);
  });

  it("等于现价的价位既不算阻力也不算支撑", () => {
    const candles: Candle[] = [mk(1, 100, 100, 100, 100)];
    const band = computePriceBand(candles, 100, { mergeTolerance: 0.0001 });
    expect(band.resistances).toHaveLength(0);
    expect(band.supports).toHaveLength(0);
  });

  it("currentPrice 非法或无数据时返回空带", () => {
    expect(computePriceBand(build(), 0).resistances).toHaveLength(0);
    expect(computePriceBand(build(), NaN).supports).toHaveLength(0);
    expect(computePriceBand([], 100).resistances).toHaveLength(0);
  });

  it("去重:相同价位多次触及只出一条带", () => {
    const dup: Candle[] = [];
    for (let i = 0; i < 6; i++) {
      dup.push(mk(i + 1, 100, 110, 99, 101)); // 阳K: open 100, close 101, high 110
    }
    const band = computePriceBand(dup, 100, { halfWidth: 10, mergeTolerance: 0.001 });
    // 100/101/110 三个价位 → 110 与 101 差 9 > 容差 0.1 → 分开
    expect(band.resistances).toHaveLength(2);
    expect(band.resistances[0].touches).toBe(6); // open 100 被触及 6 次
    expect(band.resistances[1].price).toBeCloseTo(110, 6);
    expect(band.resistances[1].touches).toBe(6);
  });

  it("阻力带在上方、支撑带在下方", () => {
    const band = computePriceBand(build(), 100, { mergeTolerance: TOL });
    for (const lvl of band.resistances as PriceBandLevel[]) {
      expect(lvl.price).toBeGreaterThan(100);
    }
    for (const lvl of band.supports as PriceBandLevel[]) {
      expect(lvl.price).toBeLessThan(100);
    }
  });
});
