export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d" | "4d" | "1w";

export interface ChartConfig {
  symbol: string;
  timeframe: Timeframe;
}

export interface SwingPoint {
  type: "high" | "low";
  price: number;
  time: number;
  index: number;
  /** "HH" | "HL" | "LH" | "LL" — FVG tier 计算需要 */
  classification?: "HH" | "HL" | "LH" | "LL";
  /**
   * 是否是「同类中的第一个」摆动点（高点的第一个 / 低点的第一个）。
   * 这类点没有前值可比，classification 是硬编码的默认值，展示时应显示 "H" / "L"。
   * 纯增量标记：不影响 classification 本身的语义（回放评分依赖它）。
   */
  firstOfType?: boolean;
  /**
   * 该摆动点被「右侧确认」的下标（= pivot 的 index + 右侧窗口长度 - 1）。
   * 到达这个下标、右侧窗口最后一根 K 收盘后，这个摆动点才真正成立
   * （数组末尾那些右窗口不完整的临时 pivot 会随新数据消失）。
   *
   * 结构引擎（structure.ts）用它作为摆动点的「生效时刻」：
   * 既避免用还没确认的摆动点做判定，也避免图右边缘的信号来回闪烁。
   */
  confirmIndex?: number;
}
