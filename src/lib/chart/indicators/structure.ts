import { Candle } from "@/types/chart";
import { SwingPoint } from "@/types/chart";
import { BOS, CHoCH } from "@/types/indicator";

/**
 * 市场结构（Market Structure）—— BOS / CHoCH 判定
 *
 * 口径（与本项目 ICT Setup 引擎一致）：
 * - **扫荡(sweep)**：影线触及结构位，但收盘没破 → 不算突破
 * - **突破(break)**：收盘价越过结构位 → 才算
 *
 * 判定逻辑是一个「趋势状态机 + 收盘突破检测」：
 * - 维护当前趋势 trend（up / down，未确立时为 null）
 * - 维护两个队列：已确认、尚未被收盘突破的 swing high / swing low
 * - 收盘越过队尾（时间上最近的那个）结构位时：
 *   · 顺势突破 → BOS（Break of Structure，结构延续）
 *   · 逆势突破 → CHoCH（Change of Character，趋势可能反转），且 trend 翻转
 *
 * ## 关键实现细节
 *
 * **1) 只用「已确认」的摆动点（confirmIndex）**
 * pivot 需要右侧 length-1 根 K 确认，所以摆动点在 index + length - 1 之后才算成立。
 * 引擎以 confirmIndex（缺省退化为 index）作为「生效时刻」，因此：
 *   - 不会用未来信息（一个摆动点生效时，它已经确认过了）
 *   - 数组末尾那些「右窗口不完整」的临时 pivot 不会参与判定（图上右边缘信号不再闪烁）
 *
 * **2) 一次行情只报一个信号**
 * 突破队尾时，一次性把收盘越过的同侧结构位全部弹出（队尾之外被顺带越过的旧位也清掉），
 * 避免同一段行情被反复报成多次 BOS。同一根 K 最多产生一个结构事件。
 *
 * **3) 初始趋势来自「结构读数」而不是「事后统计」**
 * 第一次突破发生时，用此刻已知（有分类、可比较）的摆动点推断此前的结构方向：
 *   · 最近的可比较 swing high 是 HH / 最近的可比较 swing low 是 HL → 多头
 *   · 最近的可比较 swing high 是 LH / 最近的可比较 swing low 是 LL → 空头
 * 两个都有时取时间上更晚的那个；都没有（无参照）→ 本次突破即「建立结构」，记为 BOS。
 */

export type StructureTrend = "up" | "down";

/** 结构方向读数 */
function classificationBias(classification: string): StructureTrend {
  return classification === "HH" || classification === "HL" ? "up" : "down";
}

/**
 * 用此刻已知的摆动点推断此前的结构方向
 *
 * 只看「可比较」的摆动点 —— 同类中的第一个没有前值可比（firstOfType），
 * 它的 classification 是硬编码的默认值，不能拿来当结构读数。
 *
 * @param activeHighs - 此刻已生效的 swing high（时间升序）
 * @param activeLows - 此刻已生效的 swing low（时间升序）
 */
function inferPriorBias(
  activeHighs: SwingPoint[],
  activeLows: SwingPoint[]
): StructureTrend | null {
  const candidates: { bias: StructureTrend; index: number }[] = [];

  const consider = (sw: SwingPoint | undefined) => {
    if (!sw || !sw.classification || sw.firstOfType) return;
    candidates.push({ bias: classificationBias(sw.classification), index: sw.index });
  };

  consider(activeHighs[activeHighs.length - 1]);
  consider(activeLows[activeLows.length - 1]);

  if (candidates.length === 0) return null;
  // 时间上更晚的那个读数更有代表性
  return candidates.reduce((a, b) => (b.index > a.index ? b : a)).bias;
}

/**
 * 检测 Break of Structure (BOS) 与 Change of Character (CHoCH)
 *
 * @param candles - K线数据（收盘价用于突破判定）
 * @param swingPoints - 摆动点（建议带 HH/HL/LH/LL 分类与 firstOfType 标记）
 */
export function detectStructure(
  candles: Candle[],
  swingPoints: SwingPoint[]
): { bos: BOS[]; choch: CHoCH[] } {
  const bosSignals: BOS[] = [];
  const chochSignals: CHoCH[] = [];

  if (candles.length < 2 || swingPoints.length < 2) {
    return { bos: bosSignals, choch: chochSignals };
  }

  const lastBarIndex = candles.length - 1;

  // 只保留「已确认」的摆动点：确认点 = 右侧窗口最后一根 K 的下标。
  // 数组末尾 confirmIndex 超出范围的临时 pivot 会被剔除（右边缘信号不再闪烁）。
  const eligible = swingPoints
    .filter((sw) => {
      const confirmIndex = sw.confirmIndex ?? sw.index;
      return confirmIndex <= lastBarIndex;
    })
    .sort((a, b) => a.index - b.index);

  if (eligible.length < 2) {
    return { bos: bosSignals, choch: chochSignals };
  }

  /** 摆动点的生效时刻（确认时刻），缺省退化为 index */
  const activationIndex = (sw: SwingPoint): number => sw.confirmIndex ?? sw.index;

  // 当前趋势；null = 尚未确立
  let trend: StructureTrend | null = null;

  // 已生效、尚未被收盘突破的结构位（时间升序）
  const activeHighs: SwingPoint[] = [];
  const activeLows: SwingPoint[] = [];

  let si = 0;

  for (let i = 0; i < candles.length; i++) {
    // 1) 把此刻已确认的 swing 放进对应队列
    while (si < eligible.length && activationIndex(eligible[si]) <= i) {
      const sw = eligible[si];
      if (sw.type === "high") activeHighs.push(sw);
      else activeLows.push(sw);
      si++;
    }

    const close = candles[i].close;

    // 2) 收盘突破最近的结构高 → 多头事件
    const top = activeHighs[activeHighs.length - 1];
    if (top && close > top.price) {
      const broken = top;
      // 先读趋势读数：被破的这个摆动点自身的分类就是结构方向的证据
      // （比如 LH 被上破 → 空头结构里的逆势突破 → CHoCH）
      const prior = trend ?? inferPriorBias(activeHighs, activeLows);

      // 弹出被这次收盘越过的全部同侧结构位（队尾 + 顺带越过的旧位）
      for (let k = activeHighs.length - 1; k >= 0; k--) {
        if (activeHighs[k].price < close) activeHighs.splice(k, 1);
      }


      if (prior === null || prior === "up") {
        bosSignals.push({
          type: "bullish",
          level: broken.price,
          time: candles[i].time,
          swingPoint: broken,
        });
      } else {
        chochSignals.push({
          type: "bullish",
          level: broken.price,
          time: candles[i].time,
          previousTrend: prior,
          swingPoint: broken,
        });
      }
      trend = "up";
      continue; // 一根 K 最多一个结构事件
    }

    // 3) 收盘跌破最近的结构低 → 空头事件
    const bottom = activeLows[activeLows.length - 1];
    if (bottom && close < bottom.price) {
      const broken = bottom;
      // 同上：先读趋势读数再弹出
      const prior = trend ?? inferPriorBias(activeHighs, activeLows);

      for (let k = activeLows.length - 1; k >= 0; k--) {
        if (activeLows[k].price > close) activeLows.splice(k, 1);
      }


      if (prior === null || prior === "down") {
        bosSignals.push({
          type: "bearish",
          level: broken.price,
          time: candles[i].time,
          swingPoint: broken,
        });
      } else {
        chochSignals.push({
          type: "bearish",
          level: broken.price,
          time: candles[i].time,
          previousTrend: prior,
          swingPoint: broken,
        });
      }
      trend = "down";
    }
  }

  return { bos: bosSignals, choch: chochSignals };
}
