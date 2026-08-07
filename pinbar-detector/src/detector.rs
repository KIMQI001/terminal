//! Pinbar 检测核心算法
//! 从 TypeScript 移植自 src/lib/chart/indicators/swingPoints.ts 和 engulfingPinbar.ts

use crate::types::{Candle, FVG, PinbarSignal, SwingPoint, SwingZone};

/// 检测 Swing Points（pivot high/low）
pub fn detect_swing_points(candles: &[Candle], length: usize) -> Vec<SwingPoint> {
    let mut swing_points: Vec<SwingPoint> = Vec::new();
    let mut last_high_price = 0.0;
    let mut last_low_price = f64::INFINITY;

    for i in length..candles.len() {
        // 检测 Pivot High
        if let Some(price) = ta_pivothigh(candles, i, length) {
            let classification = if last_high_price == 0.0 {
                "LH".to_string()
            } else if price > last_high_price {
                "HH".to_string()
            } else {
                "LH".to_string()
            };

            last_high_price = price;
            swing_points.push(SwingPoint {
                swing_type: "high".to_string(),
                price,
                time: candles[i].time,
                index: i,
                classification,
            });
        }

        // 检测 Pivot Low
        if let Some(price) = ta_pivotlow(candles, i, length) {
            let classification = if last_low_price == f64::INFINITY {
                "LL".to_string()
            } else if price > last_low_price {
                "HL".to_string()
            } else {
                "LL".to_string()
            };

            last_low_price = price;
            swing_points.push(SwingPoint {
                swing_type: "low".to_string(),
                price,
                time: candles[i].time,
                index: i,
                classification,
            });
        }
    }

    swing_points
}

/// ta_pivothigh - TradingView 风格的 pivot high 检测
/// 左侧 length 根K线最高价都 <= 当前高点
/// 右侧 (length-1) 根K线最高价都 < 当前高点
fn ta_pivothigh(candles: &[Candle], i: usize, length: usize) -> Option<f64> {
    if i < length {
        return None;
    }

    let high = candles[i].high;

    // 左侧检查：length 根K线的最高价都必须 <= 当前高点
    for j in 1..=length {
        if candles[i - j].high > high {
            return None;
        }
    }

    // 右侧检查：(length-1) 根K线的最高价都必须 < 当前高点（严格小于）
    for j in 1..length {
        if i + j < candles.len() && candles[i + j].high >= high {
            return None;
        }
    }

    Some(high)
}

/// ta_pivotlow - TradingView 风格的 pivot low 检测
/// 左侧 length 根K线最低价都 >= 当前低点
/// 右侧 (length-1) 根K线最低价都 > 当前低点
fn ta_pivotlow(candles: &[Candle], i: usize, length: usize) -> Option<f64> {
    if i < length {
        return None;
    }

    let low = candles[i].low;

    // 左侧检查：length 根K线的最低价都必须 >= 当前低点
    for j in 1..=length {
        if candles[i - j].low < low {
            return None;
        }
    }

    // 右侧检查：(length-1) 根K线的最低价都必须 > 当前低点（严格大于）
    for j in 1..length {
        if i + j < candles.len() && candles[i + j].low <= low {
            return None;
        }
    }

    Some(low)
}

/// 检测 Engulfing Pinbar
pub fn detect_engulfing_pinbar(
    candles: &[Candle],
    swing_points: &[SwingPoint],
    range: usize,
) -> Vec<PinbarSignal> {
    let mut signals: Vec<PinbarSignal> = Vec::new();

    if candles.len() < 2 {
        return signals;
    }

    // 构建 Swing Point 索引集合
    let swing_high_indices: Vec<usize> = swing_points
        .iter()
        .filter(|sp| sp.swing_type == "high")
        .map(|sp| sp.index)
        .collect();

    let swing_low_indices: Vec<usize> = swing_points
        .iter()
        .filter(|sp| sp.swing_type == "low")
        .map(|sp| sp.index)
        .collect();

    for i in 1..candles.len() {
        let prev = &candles[i - 1];
        let curr = &candles[i];

        let prev_is_bearish = prev.close <= prev.open;
        let prev_is_bullish = prev.close >= prev.open;
        let curr_is_bearish = curr.close < curr.open;
        let curr_is_bullish = curr.close > curr.open;

        let curr_body = (curr.close - curr.open).abs();
        if curr_body == 0.0 {
            continue; // 跳过实体为0的蜡烛
        }

        let curr_top_wick = (curr.high - curr.close.max(curr.open)).abs();
        let curr_bottom_wick = (curr.low - curr.close.min(curr.open)).abs();

        // ========== Bullish Engulfing Pinbar ==========
        if prev_is_bearish && curr_is_bullish {
            // 吞没条件
            if curr.close >= prev.open && curr.open <= prev.close {
                // 检查是否在 Swing Low 附近
                let near_swing_low = swing_low_indices.iter().any(|idx| {
                    (*idx as isize - i as isize).abs() <= range as isize
                });

                if near_swing_low || swing_low_indices.is_empty() {
                    let strength = calculate_strength(
                        curr_body,
                        curr_top_wick,
                        curr_bottom_wick,
                        true,
                    );

                    signals.push(PinbarSignal {
                        signal_type: "bullish".to_string(),
                        time: curr.time,
                        price: curr.close,
                        body_size: curr_body,
                        top_wick_size: curr_top_wick,
                        bottom_wick_size: curr_bottom_wick,
                        near_swing: if near_swing_low { "low".to_string() } else { "none".to_string() },
                        strength,
                    });
                }
            }
        }

        // ========== Bearish Engulfing Pinbar ==========
        if prev_is_bullish && curr_is_bearish {
            // 吞没条件
            if curr.close <= prev.open && curr.open >= prev.close {
                // 检查是否在 Swing High 附近
                let near_swing_high = swing_high_indices.iter().any(|idx| {
                    (*idx as isize - i as isize).abs() <= range as isize
                });

                if near_swing_high || swing_high_indices.is_empty() {
                    let strength = calculate_strength(
                        curr_body,
                        curr_top_wick,
                        curr_bottom_wick,
                        false,
                    );

                    signals.push(PinbarSignal {
                        signal_type: "bearish".to_string(),
                        time: curr.time,
                        price: curr.close,
                        body_size: curr_body,
                        top_wick_size: curr_top_wick,
                        bottom_wick_size: curr_bottom_wick,
                        near_swing: if near_swing_high { "high".to_string() } else { "none".to_string() },
                        strength,
                    });
                }
            }
        }
    }

    signals
}

/// 计算信号强度评分
fn calculate_strength(body: f64, top_wick: f64, bottom_wick: f64, is_bullish: bool) -> f64 {
    let total_range = body + top_wick + bottom_wick;
    if total_range == 0.0 {
        return 0.0;
    }

    let body_ratio = body / total_range;
    let wick_ratio = if is_bullish {
        bottom_wick / total_range - top_wick / total_range
    } else {
        top_wick / total_range - bottom_wick / total_range
    };

    // 组合评分：实体比例 + 影线差值
    (body_ratio * 0.6 + wick_ratio * 0.4 * 0.5 + 0.5).clamp(0.0, 1.0)
}

/// 检测并返回最近的 N 个 pinbar
pub fn detect_recent_pinbars(
    candles: &[Candle],
    length: usize,
    range: usize,
    limit: usize,
) -> Vec<PinbarSignal> {
    let swing_points = detect_swing_points(candles, length);
    let mut signals = detect_engulfing_pinbar(candles, &swing_points, range);

    // 按时间降序排列，取最近的 limit 个
    signals.sort_by(|a, b| b.time.cmp(&a.time));
    signals.truncate(limit);

    signals
}

/// 检测 Fair Value Gap (FVG)
/// 三根 K 线模型：candle1、candle2（中间）、candle3
/// - Bullish FVG: candle3.low > candle1.high （向上跳空缺口）
/// - Bearish FVG: candle3.high < candle1.low （向下跳空缺口）
/// 只检测缺口达到最小百分比阈值的 FVG，避免噪音
pub fn detect_fvg(candles: &[Candle], min_gap_percent: f64) -> Vec<FVG> {
    let mut fvgs: Vec<FVG> = Vec::new();
    if candles.len() < 3 {
        return fvgs;
    }

    for i in 2..candles.len() {
        let c1 = &candles[i - 2];
        let c2 = &candles[i - 1];
        let c3 = &candles[i];

        // Bullish FVG: c3.low > c1.high
        if c3.low > c1.high {
            let gap_size = c3.low - c1.high;
            let gap_percent = (gap_size / c1.high) * 100.0;
            if gap_percent >= min_gap_percent {
                fvgs.push(FVG {
                    fvg_type: "bullish".to_string(),
                    high: c3.low,
                    low: c1.high,
                    time: c2.time,
                    gap_size,
                    gap_percent,
                });
            }
        }

        // Bearish FVG: c3.high < c1.low
        if c3.high < c1.low {
            let gap_size = c1.low - c3.high;
            let gap_percent = (gap_size / c1.low) * 100.0;
            if gap_percent >= min_gap_percent {
                fvgs.push(FVG {
                    fvg_type: "bearish".to_string(),
                    high: c1.low,
                    low: c3.high,
                    time: c2.time,
                    gap_size,
                    gap_percent,
                });
            }
        }
    }

    fvgs
}

/// 找出最近一对 swing point(high + low)形成的价格区
///
/// 找最近一个 high swing(HH 或 LH)+ 最近一个 low swing(HL 或 LL),
/// 不按 classification 配对,直接取最近的两端。
/// 中线 = (high + low) / 2
///
/// 用途:启动消息、报警中显示当前 swing 价格区作为参考。
pub fn find_swing_zone(swing_points: &[SwingPoint]) -> Option<SwingZone> {
    // 倒序找最近一个 high swing
    let high = swing_points
        .iter()
        .rev()
        .find(|sp| sp.swing_type == "high")?;
    // 倒序找最近一个 low swing
    let low = swing_points
        .iter()
        .rev()
        .find(|sp| sp.swing_type == "low")?;

    Some(SwingZone {
        high: high.price,
        low: low.price,
        mid: (high.price + low.price) / 2.0,
        high_time: high.time,
        low_time: low.time,
        high_class: high.classification.clone(),
        low_class: low.classification.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_candle(time: i64, open: f64, high: f64, low: f64, close: f64, volume: f64) -> Candle {
        Candle {
            time,
            open,
            high,
            low,
            close,
            volume,
        }
    }

    #[test]
    fn test_pivot_high() {
        let candles = vec![
            create_test_candle(1, 100.0, 105.0, 95.0, 103.0, 1000.0),
            create_test_candle(2, 103.0, 106.0, 100.0, 104.0, 1000.0),
            create_test_candle(3, 104.0, 108.0, 103.0, 107.0, 1000.0), // pivot high
            create_test_candle(4, 107.0, 106.0, 102.0, 103.0, 1000.0),
        ];

        let pivots = detect_swing_points(&candles, 2);
        let high_pivots: Vec<_> = pivots.iter().filter(|p| p.swing_type == "high").collect();

        assert!(!high_pivots.is_empty());
        assert_eq!(high_pivots[0].price, 108.0);
    }

    #[test]
    fn test_engulfing_pinbar() {
        let mut candles = Vec::new();
        for i in 0..10 {
            candles.push(create_test_candle(i as i64, 100.0, 105.0, 95.0, 100.0, 1000.0));
        }
        // 添加一个 pivot low
        candles[5] = create_test_candle(5, 100.0, 102.0, 90.0, 91.0, 1000.0);
        // 前一根阴线
        candles[6] = create_test_candle(6, 91.0, 95.0, 90.0, 92.0, 1000.0);
        // 当前阳线 + 吞没
        candles[7] = create_test_candle(7, 90.0, 98.0, 89.0, 95.0, 1000.0);

        let swing_points = detect_swing_points(&candles, 2);
        let signals = detect_engulfing_pinbar(&candles, &swing_points, 5);

        assert!(!signals.is_empty());
    }

    #[test]
    fn test_detect_bullish_fvg() {
        // Bullish FVG: c1.high=100, c2 跳空上去, c3.low=105
        let candles = vec![
            create_test_candle(1, 95.0, 100.0, 90.0, 98.0, 1000.0),  // c1: high=100
            create_test_candle(2, 102.0, 110.0, 101.0, 108.0, 1000.0), // c2: 大阳线
            create_test_candle(3, 108.0, 112.0, 105.0, 110.0, 1000.0), // c3: low=105 > c1.high=100
        ];

        let fvgs = detect_fvg(&candles, 0.1);
        let bullish: Vec<&FVG> = fvgs.iter().filter(|f| f.fvg_type == "bullish").collect();

        assert_eq!(bullish.len(), 1);
        assert_eq!(bullish[0].high, 105.0);
        assert_eq!(bullish[0].low, 100.0);
        assert_eq!(bullish[0].time, 2);
        assert!((bullish[0].gap_percent - 5.0).abs() < 0.01); // gap=5, c1.high=100, 5%
    }

    #[test]
    fn test_detect_bearish_fvg() {
        // Bearish FVG: c1.low=100, c2 跳空下去, c3.high=95
        let candles = vec![
            create_test_candle(1, 105.0, 108.0, 100.0, 102.0, 1000.0), // c1: low=100
            create_test_candle(2, 98.0, 99.0, 90.0, 92.0, 1000.0),    // c2: 大阴线
            create_test_candle(3, 90.0, 95.0, 88.0, 92.0, 1000.0),    // c3: high=95 < c1.low=100
        ];

        let fvgs = detect_fvg(&candles, 0.1);
        let bearish: Vec<&FVG> = fvgs.iter().filter(|f| f.fvg_type == "bearish").collect();

        assert_eq!(bearish.len(), 1);
        assert_eq!(bearish[0].high, 100.0);
        assert_eq!(bearish[0].low, 95.0);
        assert_eq!(bearish[0].time, 2);
        assert!((bearish[0].gap_percent - 5.0).abs() < 0.01); // gap=5, c1.low=100, 5%
    }

    #[test]
    fn test_detect_fvg_min_gap_filter() {
        // 缺口太小（0.05%），应被过滤
        let candles = vec![
            create_test_candle(1, 99.95, 100.0, 99.9, 99.98, 1000.0),
            create_test_candle(2, 100.0, 100.5, 99.98, 100.4, 1000.0),
            create_test_candle(3, 100.4, 100.6, 100.05, 100.5, 1000.0),
        ];

        let fvgs = detect_fvg(&candles, 0.1);
        assert!(fvgs.is_empty(), "gap=0.05% 应被 0.1% 阈值过滤");
    }

    #[test]
    fn test_detect_fvg_no_gap() {
        // 无缺口：c3.low < c1.high（看涨不成立）
        let candles = vec![
            create_test_candle(1, 95.0, 100.0, 90.0, 98.0, 1000.0),
            create_test_candle(2, 98.0, 102.0, 97.0, 100.0, 1000.0),
            create_test_candle(3, 100.0, 103.0, 99.0, 101.0, 1000.0), // low=99 < c1.high=100
        ];

        let fvgs = detect_fvg(&candles, 0.1);
        assert!(fvgs.is_empty(), "无缺口不应产生 FVG");
    }

    #[test]
    fn test_find_swing_zone_recent_high_low() {
        // 倒序遍历:最近一个 high = HH 81000, 最近一个 low = HL 80200
        let sps = vec![
            SwingPoint { swing_type: "high".to_string(), price: 80000.0, time: 1, index: 5, classification: "LH".to_string() },
            SwingPoint { swing_type: "low".to_string(), price: 79000.0, time: 2, index: 8, classification: "LL".to_string() },
            SwingPoint { swing_type: "high".to_string(), price: 81000.0, time: 3, index: 12, classification: "HH".to_string() },
            SwingPoint { swing_type: "low".to_string(), price: 80200.0, time: 4, index: 18, classification: "HL".to_string() },
        ];
        let z = find_swing_zone(&sps).unwrap();
        assert_eq!(z.high, 81000.0);  // 最近 high = HH
        assert_eq!(z.low, 80200.0);   // 最近 low = HL
        assert_eq!(z.mid, 80600.0);   // (81000+80200)/2
        assert_eq!(z.high_class, "HH");
        assert_eq!(z.low_class, "HL");
    }

    #[test]
    fn test_find_swing_zone_picks_latest_each_side() {
        // 多个 high/low,只取最近一个 high + 最近一个 low(不要求 strict 交替)
        let sps = vec![
            SwingPoint { swing_type: "high".to_string(), price: 80000.0, time: 1, index: 5, classification: "HH".to_string() },
            SwingPoint { swing_type: "low".to_string(), price: 79500.0, time: 2, index: 8, classification: "LL".to_string() },
            SwingPoint { swing_type: "high".to_string(), price: 80500.0, time: 3, index: 12, classification: "LH".to_string() },
            SwingPoint { swing_type: "low".to_string(), price: 79900.0, time: 4, index: 18, classification: "HL".to_string() },
        ];
        let z = find_swing_zone(&sps).unwrap();
        assert_eq!(z.high, 80500.0);  // 最近 high
        assert_eq!(z.low, 79900.0);   // 最近 low
        assert_eq!(z.mid, 80200.0);
    }

    #[test]
    fn test_find_swing_zone_no_high() {
        // 只有 low swing
        let sps = vec![
            SwingPoint { swing_type: "low".to_string(), price: 80200.0, time: 1, index: 18, classification: "HL".to_string() },
        ];
        assert!(find_swing_zone(&sps).is_none());
    }

    #[test]
    fn test_find_swing_zone_no_low() {
        // 只有 high swing
        let sps = vec![
            SwingPoint { swing_type: "high".to_string(), price: 81000.0, time: 1, index: 5, classification: "HH".to_string() },
        ];
        assert!(find_swing_zone(&sps).is_none());
    }
}