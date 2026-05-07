//! Pinbar 检测核心算法
//! 从 TypeScript 移植自 src/lib/chart/indicators/swingPoints.ts 和 engulfingPinbar.ts

use crate::types::{Candle, PinbarSignal, SwingPoint};

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
}