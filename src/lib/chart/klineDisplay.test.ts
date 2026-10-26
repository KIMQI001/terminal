import { describe, it, expect } from "vitest";
import {
  isCandleVisible,
  filterVisibleItems,
  maskHiddenVolume,
} from "./klineDisplay";
import type { Candle } from "@/types/chart";
import type { HistogramData, Time } from "lightweight-charts";

const c = (time: number, open: number, close: number): Candle => ({
  time,
  open,
  high: Math.max(open, close) + 10,
  low: Math.min(open, close) - 10,
  close,
});

describe("isCandleVisible", () => {
  const anchor = 100;

  it("normal 模式全部可见", () => {
    expect(isCandleVisible(c(1, 90, 95), "normal", anchor)).toBe(true);
    expect(isCandleVisible(c(1, 110, 105), "normal", anchor)).toBe(true);
  });

  it("short(S):只留现价以上的阳线", () => {
    // 阳线 + 收在上方 → 可见
    expect(isCandleVisible(c(1, 100, 110), "short", anchor)).toBe(true);
    // 阳线 + 收在下方 → 隐藏
    expect(isCandleVisible(c(1, 90, 95), "short", anchor)).toBe(false);
    // 阴线在上方 → 隐藏
    expect(isCandleVisible(c(1, 110, 105), "short", anchor)).toBe(false);
  });

  it("long(L):只留现价以下的阴线", () => {
    // 阴线 + 收在下方 → 可见
    expect(isCandleVisible(c(1, 100, 90), "long", anchor)).toBe(true);
    // 阴线 + 收在上方 → 隐藏
    expect(isCandleVisible(c(1, 90, 95), "long", anchor)).toBe(false);
    // 阳线在下方 → 隐藏
    expect(isCandleVisible(c(1, 100, 110), "long", anchor)).toBe(false);
  });

  it("十字星(开=收)两种模式都隐藏", () => {
    expect(isCandleVisible(c(1, 100, 100), "short", anchor)).toBe(false);
    expect(isCandleVisible(c(1, 100, 100), "long", anchor)).toBe(false);
  });

  it("anchor 为 null 时不过滤", () => {
    expect(isCandleVisible(c(1, 90, 95), "short", null)).toBe(true);
    expect(isCandleVisible(c(1, 90, 95), "long", null)).toBe(true);
  });

  it("边界:收盘价正好等于锚点 → 不算「以上/以下」", () => {
    expect(isCandleVisible(c(1, 90, 100), "short", anchor)).toBe(false);
    expect(isCandleVisible(c(1, 110, 100), "long", anchor)).toBe(false);
  });
});

describe("filterVisibleItems", () => {
  const candles: Candle[] = [
    c(1, 100, 110), // 阳,上方
    c(2, 100, 90), // 阴,下方
    c(3, 90, 95), // 阳,下方
    c(4, 110, 105), // 阴,上方
  ];
  const items = candles.map((k) => ({ time: k.time as Time, value: k.close }));

  it("normal:原样返回", () => {
    expect(filterVisibleItems(items, candles, "normal", 100)).toBe(items);
  });

  it("short:只保留第 1 项", () => {
    const out = filterVisibleItems(items, candles, "short", 100);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ time: 1, value: 110 });
  });

  it("long:只保留第 2 项", () => {
    const out = filterVisibleItems(items, candles, "long", 100);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ time: 2, value: 90 });
  });
});

describe("maskHiddenVolume", () => {
  const candles: Candle[] = [
    c(1, 100, 110), // 阳,上方
    c(2, 100, 90), // 阴,下方
    c(3, 90, 95), // 阳,下方
    c(4, 110, 105), // 阴,上方
  ];
  const items: HistogramData<Time>[] = candles.map((k) => ({
    time: k.time as Time,
    value: 10,
    color: "red",
  }));

  it("normal:原样返回", () => {
    expect(maskHiddenVolume(items, candles, "normal", 100)).toBe(items);
  });

  it("short:隐藏的成交量置 0,但时间点全部保留(时间轴不塌陷)", () => {
    const out = maskHiddenVolume(items, candles, "short", 100);
    expect(out).toHaveLength(4);
    expect(out.map((o) => o.time)).toEqual([1, 2, 3, 4]);
    expect(out[0].value).toBe(10);
    expect(out[1].value).toBe(0);
    expect(out[2].value).toBe(0);
    expect(out[3].value).toBe(0);
  });

  it("long:只第 2 项保留成交量", () => {
    const out = maskHiddenVolume(items, candles, "long", 100);
    expect(out.map((o) => o.value)).toEqual([0, 10, 0, 0]);
  });
});
