import { describe, it, expect } from "vitest";
import {
  isCandleVisible,
  filterVisibleItems,
  maskHiddenVolume,
  computeVisibleTimes,
  isSameTimeList,
  isStandaloneBullish,
  isStandaloneBearish,
  getStandaloneColor,
  STANDALONE_BULLISH_COLOR,
  STANDALONE_BEARISH_COLOR,
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

  it("实时 K(isLive)永远显示:正在形成的那根不代表过滤条件", () => {
    // 就算实时 K 方向不符合,也要保留显示
    expect(isCandleVisible(c(1, 100, 110), "short", anchor, true)).toBe(true);
    expect(isCandleVisible(c(1, 110, 100), "long", anchor, true)).toBe(true);
    expect(isCandleVisible(c(1, 90, 95), "short", anchor, true)).toBe(true);
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

  it("short:保留现价上方的阳线 + 正在形成的实时 K", () => {
    const out = filterVisibleItems(items, candles, "short", 100);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ time: 1, value: 110 });
    // 最后一根 = 正在形成的实时 K → 始终保留
    expect(out[1]).toEqual({ time: 4, value: 105 });
  });

  it("long:保留现价下方的阴线 + 正在形成的实时 K", () => {
    const out = filterVisibleItems(items, candles, "long", 100);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ time: 2, value: 90 });
    expect(out[1]).toEqual({ time: 4, value: 105 });
  });

  it("最后一根(正在形成的实时 K)始终显示", () => {
    // 实时 K 是阳线且在锚点上方 → short 模式下也保留
    const cs: Candle[] = [c(1, 100, 90), c(2, 100, 110)];
    const its = cs.map((k) => ({ time: k.time as Time, value: k.close }));
    const out = filterVisibleItems(its, cs, "short", 100);
    expect(out).toHaveLength(1);
    expect(out[0].time).toBe(2);
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
    // 最后一根 = 正在形成的实时 K → 成交量照常显示
    expect(out[3].value).toBe(10);
  });

  it("long:只第 2 项 + 实时 K 保留成交量", () => {
    const out = maskHiddenVolume(items, candles, "long", 100);
    expect(out.map((o) => o.value)).toEqual([0, 10, 0, 10]);
  });
});

describe("computeVisibleTimes / isSameTimeList", () => {
  const candles: Candle[] = [
    c(1, 100, 110), // 阳,上方
    c(2, 100, 90), // 阴,下方
    c(3, 90, 95), // 阳,下方
    c(4, 110, 105), // 阴,上方(实时 K)
  ];

  it("normal:全部时间点", () => {
    expect(computeVisibleTimes(candles, "normal", 100)).toEqual([1, 2, 3, 4]);
  });

  it("short:现价上方的阳线 + 正在形成的实时 K", () => {
    expect(computeVisibleTimes(candles, "short", 100)).toEqual([1, 4]);
  });

  it("long:现价下方的阴线 + 正在形成的实时 K", () => {
    expect(computeVisibleTimes(candles, "long", 100)).toEqual([2, 4]);
  });

  it("isSameTimeList:比较两个时间点列表", () => {
    expect(isSameTimeList([1, 2], [1, 2])).toBe(true);
    expect(isSameTimeList([1, 2], [2, 1])).toBe(false);
    expect(isSameTimeList([1, 2], [1])).toBe(false);
    expect(isSameTimeList(null, [1])).toBe(false);
    expect(isSameTimeList([1], null)).toBe(false);
  });
});

describe("独立 K 线(standalone)", () => {
  //  0 阳  1 阴  2 阳  3 阳  4 阴  5 阴  6 阳(实时)
  //  0 前无 / 后是阴 → 独立阳k ✓
  //  1 前后都是阳 → 独立阴k ✓
  //  2 后是阳 → 不是独立阳k
  //  3 前是阳 → 不是独立阳k
  //  4 后是阴 → 不是独立阴k
  //  5 前是阴 → 不是独立阴k
  //  6 前是阴 / 后无 → 独立阳k ✓
  const candles: Candle[] = [
    c(0, 100, 110), // 阳
    c(1, 110, 105), // 阴
    c(2, 105, 115), // 阳
    c(3, 115, 125), // 阳
    c(4, 125, 118), // 阴
    c(5, 118, 112), // 阴
    c(6, 112, 120), // 阳
  ];

  it("独立阳k:自身是阳线且前后都不是阳线", () => {
    expect(isStandaloneBullish(candles, 6)).toBe(true);
    expect(isStandaloneBullish(candles, 0)).toBe(true); // 后面是阴线
    expect(isStandaloneBullish(candles, 2)).toBe(false); // 后面紧跟阳线
    expect(isStandaloneBullish(candles, 3)).toBe(false); // 前面紧跟阳线
    expect(isStandaloneBullish(candles, 1)).toBe(false); // 自身是阴线
  });

  it("独立阴k:自身是阴线且前后都不是阴线", () => {
    expect(isStandaloneBearish(candles, 1)).toBe(true); // 前后都是阳线
    expect(isStandaloneBearish(candles, 4)).toBe(false); // 后面紧跟阴线
    expect(isStandaloneBearish(candles, 5)).toBe(false); // 前面紧跟阴线
    expect(isStandaloneBearish(candles, 6)).toBe(false); // 自身是阳线
  });

  it("边界:第一根 / 最后一根只看存在的邻边", () => {
    const two: Candle[] = [c(0, 100, 110), c(1, 110, 105)];
    expect(isStandaloneBullish(two, 0)).toBe(true); // 后无 / 后面是阴线
    expect(isStandaloneBearish(two, 1)).toBe(true); // 前面是阳线
  });

  it("getStandaloneColor:S 模式独立阳k 橙色,L 模式独立阴k 蓝色", () => {
    expect(getStandaloneColor(candles, 6, "short")).toBe(STANDALONE_BULLISH_COLOR);
    expect(getStandaloneColor(candles, 6, "long")).toBeNull();
    expect(getStandaloneColor(candles, 1, "long")).toBe(STANDALONE_BEARISH_COLOR);
    expect(getStandaloneColor(candles, 1, "short")).toBeNull();
    expect(getStandaloneColor(candles, 6, "normal")).toBeNull();
  });
});
