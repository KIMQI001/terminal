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
 * **5) 预测下一个 BOS / CHoCH 的**目标位**（上下各一个）**
 *
 * 结构位分成两层：
 *   · **门槛位** = 离现价最近的那个未破结构位（下方最高 / 上方最低）
 *     → 收盘价越过它，就会真的报出 BOS / CHoCH 事件（虚线事件线）
 *   · **目标位** = 门槛位**外侧**的下一个结构位（下方第二高 / 上方第二低）
 *     → 也就是「LL 底下的目标」「HH 上方的目标」，渲染层画成**实线**
 * 事件是 BOS 还是 CHoCH，取决于当前趋势：顺势=BOS，逆势=CHoCH。
 * 目标位被收盘价越过 → 它从候选里消失 → 实线自动外推到更远的目标。
 *
 * **6) 预测层是实时的（实时极值）**
 *
 * 上面说的「结构位」都来自 pivot，需要右侧 length-1 根 K 确认才成立
 * （1d 要等 29 天），直接用会有明显迟滞。
 * 所以预测层额外维护**实时极值**：
 *   · provisionalHigh / provisionalLow = 还没被收盘价突破的最近一个高/低点
 *   · 它们可以是任意一根 K 的极值，不用等确认 → K 线一刷新，预测位就跟着动
 * 实时极值**只参与预测**（算门槛 / 目标），**不参与 BOS/CHoCH 事件判定** ——
 * 事件仍然只在 pivot 确认后触发，避免前视偏差、避免信号事后改口。
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

  // 实时极值（未确认）—— 只用于预测层，不参与事件判定
  let provisionalHigh: SwingPoint | null = null;
  let provisionalLow: SwingPoint | null = null;

  let si = 0;

  for (let i = 0; i < candles.length; i++) {
    // 1) 把此刻已确认的 swing 放进对应队列
    while (si < eligible.length && activationIndex(eligible[si]) <= i) {
      const sw = eligible[si];
      // 注：这里**不要**把对应的实时极值清空 —— 清空的话下一根 K 会用
      // 自己的 high/low 重建一个更低的实时极值（等于凭空造出一个新位）。
      // 重复计入由下面的合并函数按 index 去重解决。
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

    // ── 实时极值（未确认）───────────────────────────────
    // 「还没被收盘价突破的最近一个高点 / 低点」。
    // 一旦收盘价越过了它，它就作废 —— 结构位被破坏就是被破坏了，价格回来也不复原。
    if (provisionalHigh && bar.close > provisionalHigh.price) provisionalHigh = null;
    if (!provisionalHigh || bar.high > provisionalHigh.price) {
      provisionalHigh = { type: "high", price: bar.high, time: bar.time, index: i, confirmIndex: i };
    }
    if (provisionalLow && bar.close < provisionalLow.price) provisionalLow = null;
    if (!provisionalLow || bar.low < provisionalLow.price) {
      provisionalLow = { type: "low", price: bar.low, time: bar.time, index: i, confirmIndex: i };
    }
  }

  // 4) 预测下一个 BOS / CHoCH 的**目标位**（上下各一个）
  //    候选 = 已确认未破的结构位 + 实时极值（未确认），两者合起来才是「现在看得见的位」
  //      · 门槛位 = 候选里离现价最近的那个（下方取最高价、上方取最低价）
  //      · 目标位 = 门槛位**外侧**的下一个（下方取第二高、上方取第二低）
  //    定性沿用引擎的规则：顺势=BOS，逆势=CHoCH。
  //    注意：影线插破但收盘收回的位**仍然留在这里** → 依然被标成「下一个 BOS」实线。
  const effectiveTrend = trend ?? inferPriorBias(activeHighs, activeLows);

  const bullish = pickTarget(activeHighs, provisionalHigh, "bullish", effectiveTrend);
  const bearish = pickTarget(activeLows, provisionalLow, "bearish", effectiveTrend);

  return {
    bos: bosSignals,
    choch: chochSignals,
    projection: { bullish, bearish },
  };
}

/**
 * 选出一条目标预测
 *
 * · **门槛位 trigger** = 离现价最近的那个位（下方取最高、上方取最低）
 *   候选 = 已确认未破的结构位 + 实时极值 → 所以门槛是实时的
 * · **目标位 target** = 门槛位**外侧**的下一个**已确认结构位**
 *   （外侧没有已确认结构位时，退回用实时极值兜底）
 *
 * 目标优先用已确认结构位，是因为它才是真正的「结构目标」；
 * 未确认的插破点只用来更新门槛，不去抢目标的位。
 */
function pickTarget(
  confirmed: SwingPoint[],
  provisional: SwingPoint | null,
  direction: "bullish" | "bearish",
  trend: StructureTrend | null
): StructurePrediction | null {
  const all = mergeCandidates(confirmed, provisional);
  if (all.length === 0) return null;

  // 上方按价格升序（门槛 = 最低），下方按价格降序（门槛 = 最高）
  const sorted =
    direction === "bullish"
      ? [...all].sort((a, b) => a.price - b.price)
      : [...all].sort((a, b) => b.price - a.price);
  const trigger = sorted[0];

  // 门槛外侧最近的「已确认结构位」
  const outerConfirmed = confirmed.filter((c) =>
    direction === "bullish" ? c.price > trigger.price : c.price < trigger.price
  );
  const target =
    outerConfirmed.length > 0
      ? direction === "bullish"
        ? outerConfirmed.reduce((a, b) => (b.price < a.price ? b : a))
        : outerConfirmed.reduce((a, b) => (b.price > a.price ? b : a))
      : sorted[1];

  if (!target) return null;
  return makeTarget(target, trigger, direction, trend);
}

/**
 * 合并「已确认的结构位」与「实时极值」→ 候选位集合
 *
 * 同一个下标可能两边都有（实时极值后来被 pivot 确认了）→ 按 index 去重，
 * 已确认的那份优先（它带 HH/LL 分类）。
 */
function mergeCandidates(confirmed: SwingPoint[], provisional: SwingPoint | null): SwingPoint[] {
  if (!provisional) return [...confirmed];
  const map = new Map<number, SwingPoint>();
  map.set(provisional.index, provisional);
  for (const c of confirmed) map.set(c.index, c);
  return [...map.values()];
}

/**
 * 组装一条目标预测
 *
 * @param target - 目标位（门槛外侧的下一个结构位）
 * @param trigger - 门槛位（离现价最近的那个未破结构位）
 * @param direction - 目标方向
 * @param trend - 当前趋势（决定突破门槛时是 BOS 还是 CHoCH）
 */
function makeTarget(
  target: SwingPoint,
  trigger: SwingPoint,
  direction: "bullish" | "bearish",
  trend: StructureTrend | null
): StructurePrediction {
  const kind =
    direction === "bullish"
      ? trend === "down"
        ? "choch"
        : "bos"
      : trend === "up"
        ? "choch"
        : "bos";
  return {
    kind,
    direction,
    level: target.price,
    triggerLevel: trigger.price,
    swingPoint: target,
  };
}
