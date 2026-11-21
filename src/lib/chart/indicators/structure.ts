import { Candle } from "@/types/chart";
import { SwingPoint } from "@/types/chart";
import { BOS, CHoCH, StructureProjection, StructurePrediction } from "@/types/indicator";

/**
 * 市场结构（Market Structure）—— BOS / CHoCH 判定
 *
 * 口径：**实体（收盘价）突破**
 * - swing high 被破：任意一根 K 的 **收盘价 > 结构位**
 * - swing low 被破：任意一根 K 的 **收盘价 < 结构位**
 * - 影线穿过去但收盘没收回 → 只是扫荡（sweep），**不算突破**，结构位依然有效
 *
 * 这条口径同时决定了「预测位」的含义：
 * 结构位只要还没被**收盘价**越过，就仍然是下一个 BOS / CHoCH 的目标，
 * 渲染层用**实线**把它标出来；等价格真的收上去/收下去，引擎报出事件，
 * 这条实线随之变回虚线（事件线），并在更远的位置出现新的实线预测位。
 *
 * 判定逻辑是一个「趋势状态机 + 突破检测」：
 * - 维护当前趋势 trend（up / down，未确立时为 null）
 * - 维护两个队列：已确认、尚未被突破的 swing high / swing low
 * - 价格越过结构位时：
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
 * **2) 收盘突破不会「提前」**
 * pivot 的右侧检查本身就会作废那些被后来 K 线穿过的极值：
 * 高点要求窗口内 `high < 极值`，低点要求 `low > 极值`。
 * 所以从生效时刻（= 右窗口最后一根 K）往后数，第一根有可能破位的 K 一定在生效之后，
 * 收盘口径**不会**引入任何前视偏差。
 *
 * **3) 一根 K 越过多个结构位 → 每个位都单独报**
 * 之前只报队尾、其余被静默丢弃，导致「明明破了却没标」的真实漏报
 * （例：1h 2026-10-29 一根 K 同时跌破 79057.4 与 79224.7，只标了后者）。
 * 现在按**价格路径顺序**逐个报：
 *   · 上破时按价位从低到高（价格先穿低的）
 *   · 下破时按价位从高到低（价格先穿高的）
 * 同一根 K 里，第一个位按「突破前的趋势」定性（可能是 CHoCH），
 * 之后的位都是该方向趋势已经确立后的延续 → 记 BOS。
 *
 * **4) 初始趋势来自「结构读数」而不是「事后统计」**
 * 第一次突破发生时，用此刻已知（有分类、可比较）的摆动点推断此前的结构方向：
 *   · 最近的可比较 swing high 是 HH / 最近的可比较 swing low 是 HL → 多头
 *   · 最近的可比较 swing high 是 LH / 最近的可比较 swing low 是 LL → 空头
 * 两个都有时取时间上更晚的那个；都没有（无参照）→ 本次突破即「建立结构」，记为 BOS。
 *
 * **5) 预测下一个 BOS / CHoCH（上下各一个）**
 * 引擎跑完后，队列里剩下的就是「还没破的结构位」：
 *   · 上方最近的一个（activeHighs 里最低的）→ 破它会触发的事件
 *   · 下方最近的一个（activeLows 里最高的）→ 破它会触发的事件
 * 事件是 BOS 还是 CHoCH，取决于当前趋势：顺势=BOS，逆势=CHoCH。
 * 渲染层把这两条画成**实线**，价格触及后引擎会真的报出事件 → 线变回虚线。
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
 * @param candles - K线数据（用**收盘价**判定突破）
 * @param swingPoints - 摆动点（建议带 HH/HL/LH/LL 分类与 firstOfType 标记）
 */
export function detectStructure(
  candles: Candle[],
  swingPoints: SwingPoint[]
): { bos: BOS[]; choch: CHoCH[]; projection: StructureProjection } {
  const bosSignals: BOS[] = [];
  const chochSignals: CHoCH[] = [];

  const emptyProjection = (): StructureProjection => ({ bullish: null, bearish: null });

  if (candles.length < 2 || swingPoints.length < 2) {
    return { bos: bosSignals, choch: chochSignals, projection: emptyProjection() };
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
    return { bos: bosSignals, choch: chochSignals, projection: emptyProjection() };
  }

  /** 摆动点的生效时刻（确认时刻），缺省退化为 index */
  const activationIndex = (sw: SwingPoint): number => sw.confirmIndex ?? sw.index;

  // 当前趋势；null = 尚未确立
  let trend: StructureTrend | null = null;

  // 已生效、尚未被突破的结构位（时间升序）
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

    const bar = candles[i];

    // 2) 收盘上破结构高 → 多头事件
    //    这一根 K 可能同时穿过多个结构高，全部要报出来（之前只报队尾，其余被静默丢弃）
    if (activeHighs.length > 0) {
      const brokenHighs = activeHighs.filter((sw) => bar.close > sw.price);
      if (brokenHighs.length > 0) {
        // 先读趋势读数：被破的摆动点自身的分类就是结构方向的证据
        // （比如 LH 被上破 → 空头结构里的逆势突破 → CHoCH）
        let prior: StructureTrend | null = trend ?? inferPriorBias(activeHighs, activeLows);

        // 价格从下往上走 → 先穿价位最低的那个
        const ordered = [...brokenHighs].sort((a, b) => a.price - b.price);

        for (const broken of ordered) {
          if (prior === null || prior === "up") {
            bosSignals.push({
              type: "bullish",
              level: broken.price,
              time: bar.time,
              swingPoint: broken,
            });
          } else {
            chochSignals.push({
              type: "bullish",
              level: broken.price,
              time: bar.time,
              previousTrend: prior,
              swingPoint: broken,
            });
          }
          // 本根 K 内第一个位定性之后，趋势已经翻成多头，后续位都是顺势延续
          prior = "up";
        }

        trend = "up";

        // 弹掉所有被这根 K 收穿的结构高
        for (let k = activeHighs.length - 1; k >= 0; k--) {
          if (bar.close > activeHighs[k].price) activeHighs.splice(k, 1);
        }
      }
    }

    // 3) 收盘下破结构低 → 空头事件
    if (activeLows.length > 0) {
      const brokenLows = activeLows.filter((sw) => bar.close < sw.price);
      if (brokenLows.length > 0) {
        let prior: StructureTrend | null = trend ?? inferPriorBias(activeHighs, activeLows);

        // 价格从上往下走 → 先穿价位最高的那个
        const ordered = [...brokenLows].sort((a, b) => b.price - a.price);

        for (const broken of ordered) {
          if (prior === null || prior === "down") {
            bosSignals.push({
              type: "bearish",
              level: broken.price,
              time: bar.time,
              swingPoint: broken,
            });
          } else {
            chochSignals.push({
              type: "bearish",
              level: broken.price,
              time: bar.time,
              previousTrend: prior,
              swingPoint: broken,
            });
          }
          prior = "down";
        }

        trend = "down";

        for (let k = activeLows.length - 1; k >= 0; k--) {
          if (bar.close < activeLows[k].price) activeLows.splice(k, 1);
        }
      }
    }
  }

  // 4) 预测下一个 BOS / CHoCH（上下各一个）
  //    队列里剩下的都是「还没被收盘价破掉的结构位」：
  //      · 上方最近的（activeHighs 里价位最低的）→ 价格收盘站上它会触发什么
  //      · 下方最近的（activeLows 里价位最高的）→ 价格收盘跌破它会触发什么
  //    定性沿用引擎的规则：顺势=BOS，逆势=CHoCH。
  //    注意：影线插破但收盘收回的位**仍然留在这里** → 依然被标成「下一个 BOS」实线。
  const effectiveTrend = trend ?? inferPriorBias(activeHighs, activeLows);

  let bullish: StructurePrediction | null = null;
  let bearish: StructurePrediction | null = null;

  if (activeHighs.length > 0) {
    const nearest = activeHighs.reduce((a, b) => (b.price < a.price ? b : a));
    bullish = {
      kind: effectiveTrend === "down" ? "choch" : "bos",
      direction: "bullish",
      level: nearest.price,
      swingPoint: nearest,
    };
  }

  if (activeLows.length > 0) {
    const nearest = activeLows.reduce((a, b) => (b.price > a.price ? b : a));
    bearish = {
      kind: effectiveTrend === "up" ? "choch" : "bos",
      direction: "bearish",
      level: nearest.price,
      swingPoint: nearest,
    };
  }

  return {
    bos: bosSignals,
    choch: chochSignals,
    projection: { bullish, bearish },
  };
}
