//! Wick SR 检测器
//!
// 长 wick 判定(参考前端 src/lib/chart/indicators/rejection.ts):
// - range = high - low
//! - 上影(阻力):(high - bodyTop) / range >= wick_ratio(默认 0.4)
//! - 下影(支撑):(bodyBottom - low) / range >= wick_ratio
//! - 一根 K 可以同时给两个候选(长腿十字)
//!
//! actionable level:
//! - 阻力:level = (bodyTop + high) / 2, zone = [bodyTop, high]
//! - 支撑:level = (low + bodyBottom) / 2, zone = [low, bodyBottom]
//!
//! tier:看上一根同方向 wick,同方向 +1,不同方向 reset 到 1

use crate::types::{Candle, SwingPoint, WickSR};

#[derive(Debug, Clone)]
pub struct DetectOptions {
    pub wick_ratio: f64,
    /// 反转 wick 判定的回溯 K 根数(默认 10)
    pub reversal_lookback: i64,
    /// 高等级 wick(十字星)的实体最大 USD 值(默认 50)
    pub body_max_usd: f64,
    /// 高等级 wick 的 K 整体 range 最大 USD 值(默认 200)— 整体小更可靠
    pub range_max_usd: f64,
}

impl Default for DetectOptions {
    fn default() -> Self {
        Self {
            wick_ratio: 0.4,
            reversal_lookback: 10,
            body_max_usd: 50.0,
            range_max_usd: 250.0,
        }
    }
}

/// 反转 wick 判定:R(上影/阻力)所在 K 的 high 是回溯期内最高
/// (突破前高,看跌反转) / S(下影/支撑)所在 K 的 low 是回溯期内最低
/// (跌破前低,看涨反转)
fn is_reversal_wick(
    candle: &Candle,
    candles: &[Candle],
    side: &str,
    lookback: i64,
) -> bool {
    let idx = candles.iter().position(|c| c.time == candle.time);
    let idx = match idx {
        Some(i) => i as i64,
        None => return false,
    };
    let start = (idx - lookback).max(0) as usize;
    let end = idx as usize;
    if end <= start + 1 {
        return false;  // 回溯窗口太短
    }
    if side == "bearish" {
        // R 上影/阻力:所在 K 的 high 是窗口内最高
        let prev_max = candles[start..end]
            .iter()
            .map(|c| c.high)
            .fold(f64::NEG_INFINITY, f64::max);
        candle.high >= prev_max
    } else if side == "bullish" {
        // S 下影/支撑:所在 K 的 low 是窗口内最低
        let prev_min = candles[start..end]
            .iter()
            .map(|c| c.low)
            .fold(f64::INFINITY, f64::min);
        candle.low <= prev_min
    } else {
        false
    }
}

/// 检测 wick SR zones(对应 K 索引 i,会跳过最后一根 — 还在形成)
pub fn detect_wick_sr(
    candles: &[Candle],
    swing_points: &[SwingPoint],
    options: &DetectOptions,
) -> Vec<WickSR> {
    if candles.len() < 3 {
        return vec![];
    }

    let mut results = Vec::new();
    let last_idx = candles.len() - 1; // 跳过最后一根(进行中)
    for i in 2..last_idx {
        let c = &candles[i];
        let body_top = c.open.max(c.close);
        let body_bottom = c.open.min(c.close);
        let range = c.high - c.low;
        if range <= 0.0 {
            continue;
        }

        let upper_wick = c.high - body_top;
        let lower_wick = body_bottom - c.low;
        let upper_ratio = upper_wick / range;
        let lower_ratio = lower_wick / range;

        // 上影(阻力,bearish) — R 在阳 K = 高等级(卖方没压住,收盘价入场)
        if upper_ratio >= options.wick_ratio {
            let level = (body_top + c.high) / 2.0;
            let zone_low = body_top;
            let zone_high = c.high;
            let reversal = is_reversal_wick(c, candles, "bearish", options.reversal_lookback);
            // 阳 K:close > open
            let is_bullish_candle = c.close > c.open;
            let body_size = (c.close - c.open).abs();
            let small_body = body_size < options.body_max_usd;  // 实体 < 阈值(必要条件)
            let small_range = range < options.range_max_usd;  // 整体小(保险,大 K 实体小但 wick 不显著)
            // R 在阳 K(close>open)= K 收阳 → 卖方没把 K 打回 → 反转信号
            // R 在阴 K = 普通 wick(卖方压住)
            // + 十字星(实体+整体都小)
            let directional_match = is_bullish_candle;  // R 在阳 K
            let is_doji = small_body && small_range;
            let high_quality = directional_match || is_doji;
            let high_quality_reason = match (directional_match, is_doji) {
                (true, true) => "both",
                (true, false) => "directional",
                (false, true) => "doji",
                (false, false) => "",
            };
            results.push(WickSR {
                time: c.time,
                side: "bearish".to_string(),
                level,
                zone_low,
                zone_high,
                ratio: upper_ratio,
                tier: 1,
                index: i as i64,
                reversal,
                high_quality,
                high_quality_reason: high_quality_reason.to_string(),
            });
        }

        // 下影(支撑,bullish) — S 在阴 K = 高等级(买方没接住,收盘价入场)
        if lower_ratio >= options.wick_ratio {
            let level = (c.low + body_bottom) / 2.0;
            let zone_low = c.low;
            let zone_high = body_bottom;
            let reversal = is_reversal_wick(c, candles, "bullish", options.reversal_lookback);
            // 阴 K:close < open
            let is_bearish_candle = c.close < c.open;
            let body_size = (c.close - c.open).abs();
            let small_body = body_size < options.body_max_usd;  // 实体 < 阈值(必要条件)
            let small_range = range < options.range_max_usd;  // 整体小(保险,大 K 实体小但 wick 不显著)
            // S 在阴 K(close<open)= K 收阴 → 买方没把 K 接住 → 反转信号
            // S 在阳 K = 普通 wick(买方接住)
            // + 十字星(实体+整体都小)
            let directional_match = is_bearish_candle;  // S 在阴 K
            let is_doji = small_body && small_range;
            let high_quality = directional_match || is_doji;  // 对齐 R 判定
            let high_quality_reason = match (directional_match, is_doji) {
                (true, true) => "both",
                (true, false) => "directional",
                (false, true) => "doji",
                (false, false) => "",
            };
            results.push(WickSR {
                time: c.time,
                side: "bullish".to_string(),
                level,
                zone_low,
                zone_high,
                ratio: lower_ratio,
                tier: 1,
                index: i as i64,
                reversal,
                high_quality,
                high_quality_reason: high_quality_reason.to_string(),
            });
        }
    }

    // 算 tier:看 live 数组里前一个同方向 wick,跨过同 K 内的另一个 wick,
    // 跨过已擦除(is_tested = true)— 思路同前端,简化为按方向连续 +1
    // (这里是后端,detection 在 K close 后跑,擦除由前端处理)
    for i in 0..results.len() {
        if i == 0 {
            results[i].tier = 1;
            continue;
        }
        // 跨过同一根 K 内的另一个 wick + 跨过 swing point 严格分类的 HH/LL
        // 简化:找前一个同方向 wick,跨过同 K + 同 index 的另一侧
        let want_type = if results[i].side == "bullish" {
            "bullish"
        } else {
            "bearish"
        };
        let mut prev_tier = 0;
        let mut found = false;
        for k in (0..i).rev() {
            if results[k].side != want_type {
                continue;
            }
            // 跨过同根 K(不算)
            if results[k].index == results[i].index {
                continue;
            }
            // 不同方向或新段 → 重置为 1(再找更早的)
            // 简化:同一方向连续 +1,不同方向 reset 到 1
            prev_tier = results[k].tier;
            found = true;
            break;
        }
        // 检测中间是否有 strict HH/LL 段切换(可选)
        let want_class = if want_type == "bullish" { "LL" } else { "HH" };
        let has_new_ref = swing_points.iter().any(|sp| {
            sp.classification.as_deref() == Some(want_class)
                && sp.index > if found { results[i - 1].index } else { 0 }
                && sp.index < results[i].index
        });
        if has_new_ref {
            results[i].tier = 1;
        } else if found {
            results[i].tier = prev_tier + 1;
        } else {
            results[i].tier = 1;
        }
    }

    results
}

/// 检测**最新一根 K**(candles 最后一根)的 wick SR zones ——
/// 历史 K 不再处理,只针对刚 close 的这根 K。
///
/// reversal 判定仍用 `candles` 全数组:is_reversal_wick 找 candle.time 的
/// idx,自动只取 idx - lookback .. idx 的最近 N 根(默认 10)。
///
/// 返回 0/1/2 个 wick(上影 R + 下影 S 可能同时命中)。
/// 主循环在 main.rs 收到此 signals 后,只对最新 K 做报警 / 下单。
pub fn detect_wick_sr_for_last(
    candles: &[Candle],
    options: &DetectOptions,
) -> Vec<WickSR> {
    if candles.len() < 3 {
        return vec![];
    }
    let new_idx = candles.len() - 1;
    let c = &candles[new_idx];
    let body_top = c.open.max(c.close);
    let body_bottom = c.open.min(c.close);
    let range = c.high - c.low;
    if range <= 0.0 {
        return vec![];
    }

    let upper_wick = c.high - body_top;
    let lower_wick = body_bottom - c.low;
    let upper_ratio = upper_wick / range;
    let lower_ratio = lower_wick / range;

    let mut results = Vec::new();

    // 上影(阻力,bearish)
    if upper_ratio >= options.wick_ratio {
        let level = (body_top + c.high) / 2.0;
        let zone_low = body_top;
        let zone_high = c.high;
        let reversal = is_reversal_wick(c, candles, "bearish", options.reversal_lookback);
        let is_bullish_candle = c.close > c.open;
        let body_size = (c.close - c.open).abs();
        let small_body = body_size < options.body_max_usd;
        let small_range = range < options.range_max_usd;
        let directional_match = is_bullish_candle;
        let is_doji = small_body && small_range;
        let high_quality = directional_match || is_doji;
        let high_quality_reason = match (directional_match, is_doji) {
            (true, true) => "both",
            (true, false) => "directional",
            (false, true) => "doji",
            (false, false) => "",
        };
        results.push(WickSR {
            time: c.time,
            side: "bearish".to_string(),
            level,
            zone_low,
            zone_high,
            ratio: upper_ratio,
            tier: 1,
            index: new_idx as i64,
            reversal,
            high_quality,
            high_quality_reason: high_quality_reason.to_string(),
        });
    }

    // 下影(支撑,bullish)
    if lower_ratio >= options.wick_ratio {
        let level = (c.low + body_bottom) / 2.0;
        let zone_low = c.low;
        let zone_high = body_bottom;
        let reversal = is_reversal_wick(c, candles, "bullish", options.reversal_lookback);
        let is_bearish_candle = c.close < c.open;
        let body_size = (c.close - c.open).abs();
        let small_body = body_size < options.body_max_usd;
        // 对齐 R 判定:方向匹配 OR 十字星(both 都需要 small_range)
        let small_range = range < options.range_max_usd;
        let directional_match = is_bearish_candle;
        let is_doji = small_body && small_range;
        let high_quality = directional_match || is_doji;
        let high_quality_reason = match (directional_match, is_doji) {
            (true, true) => "both",
            (true, false) => "directional",
            (false, true) => "doji",
            (false, false) => "",
        };
        results.push(WickSR {
            time: c.time,
            side: "bullish".to_string(),
            level,
            zone_low,
            zone_high,
            ratio: lower_ratio,
            tier: 1,
            index: new_idx as i64,
            reversal,
            high_quality,
            high_quality_reason: high_quality_reason.to_string(),
        });
    }

    results
}

/// 检测最近一个 FVG 的方向(用 K 线 + FVG 三档字段判断)
/// 简化:扫最后 LOOKBACK_FVG 根 K 线,找最近的 bullish/bearish FVG
///
/// 返回 `Some(true)` = 最近 FVG 是看涨(long 趋势) / `Some(false)` = 看跌
/// `None` = 没找到 FVG(无趋势判断)
pub fn latest_fvg_direction(
    candles: &[crate::types::Candle],
    fvg_size_ratio: f64,  // gap / prev.high(看涨)或 / prev.low(看跌)
) -> Option<bool> {
    if candles.len() < 3 {
        return None;
    }
    // 从右往左找最近一个 FVG
    let last_idx = candles.len() - 1;
    for i in (2..last_idx).rev() {
        let c1 = &candles[i - 2];
        let _c2 = &candles[i - 1];  // 中间 K:FVG 三K结构只取 c1/c3
        let c3 = &candles[i];
        let range_c3_low_to_c1_high = c3.low - c1.high;
        let range_c1_low_to_c3_high = c1.low - c3.high;

        // 看涨 FVG:gap 在 c3.low - c1.high,需 > 0
        if range_c3_low_to_c1_high > 0.0
            && c1.high > 0.0
            && (range_c3_low_to_c1_high / c1.high) * 100.0 >= fvg_size_ratio
        {
            return Some(true);
        }

        // 看跌 FVG:gap 在 c1.low - c3.high,需 > 0
        if range_c1_low_to_c3_high > 0.0
            && c1.low > 0.0
            && (range_c1_low_to_c3_high / c1.low) * 100.0 >= fvg_size_ratio
        {
            return Some(false);
        }
    }
    None
}
