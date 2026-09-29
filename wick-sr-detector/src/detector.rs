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
        // 用户原话:'加条件,如果影线在 40-60%区间内,另一头影线必须大于 10%,如果大于 60%,则不用管另一头'
        // 长影 ≥ 60% range → 任何 wick 都触发(不用管另一头)
        // 长影 40-60% range → 另一头影 > 10% range 才触发
        // wick_ratio(默认 0.4)仍是 effective 下限:< 40% 不触发
        let upper_wick_strong = upper_ratio >= 0.60;
        let upper_wick_conditional =
            upper_ratio >= 0.40 && upper_ratio < 0.60 && lower_ratio > 0.15;
        if upper_wick_strong || upper_wick_conditional {
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
        // 用户原话:'加条件,如果影线在 40-60%区间内,另一头影线必须大于 10%'
        // 长影 ≥ 60% range → 任何 wick 都触发
        // 长影 40-60% range → 另一头影 > 10% range 才触发
        let lower_wick_strong = lower_ratio >= 0.60;
        let lower_wick_conditional =
            lower_ratio >= 0.40 && lower_ratio < 0.60 && upper_ratio > 0.15;
        if lower_wick_strong || lower_wick_conditional {
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

/// OC 中点 = (PDO + PDC) / 2
/// ICT 概念:下跌趋势的 OC 中点是"多头硬支撑",上涨趋势的 OC 中点是"空头硬阻力"
/// 价格碰到 OC 中点附近出现 S/R → 强反转信号
pub fn oc_midpoint(pdo: f64, pdc: f64) -> f64 {
    (pdo + pdc) / 2.0
}

/// 反转 wick 跟 OC 中点的"接近度"判定
/// - S 做多:wick_zone_low 离 oc_midpoint 越近 = 强支撑
/// - R 做空:wick_zone_high 离 oc_midpoint 越近 = 强阻力
/// 距离 < threshold → 强反转
pub fn is_strong_reversal_near_oc(
    oc_mid: f64,
    wick_zone_low: f64,
    wick_zone_high: f64,
    wick_side: &str,
    threshold_usd: f64,
) -> bool {
    let dist = if wick_side == "bullish" {
        (oc_mid - wick_zone_low).abs()
    } else {
        (wick_zone_high - oc_mid).abs()
    };
    dist < threshold_usd
}

/// 根据 1D 锚点 (PDO, PDH, PDL, PDC) 跟当前价的关系,判定方向
/// 复用前端 `DailyKPanel.tsx` 概念:4 个锚点都是"价格会反应的位置"
/// - 当前价 > PDH:突破前高 → 强势 long
/// - 当前价 < PDL:跌破前低 → 强势 short
/// - PDH ≥ 当前价 ≥ PDL:在区间内,看 PDO/PDC
///   - > PDC:高于昨日收盘 → 偏多
///   - < PDC:低于昨日收盘 → 偏空
///   - == PDC:中性(兜底 long)
/// 返回 (long_only, 来源标签)
pub fn daily_anchor_direction(
    pdo: f64,
    pdh: f64,
    pdl: f64,
    pdc: f64,
    current_price: f64,
) -> (bool, &'static str) {
    if current_price > pdh {
        (true, "long > PDH(突破前高)")
    } else if current_price < pdl {
        (false, "short < PDL(跌破前低)")
    } else if current_price > pdc {
        (true, "long > PDC(高于昨日收)")
    } else if current_price < pdc {
        (false, "short < PDC(低于昨日收)")
    } else {
        (true, "long == PDC(等于昨日收)")
    }
}

/// 检测方向:SR + FVG 必须一致才确定方向
///
/// 决策表:
/// | FVG | SR(最高 R/最低 S)| 一致? | 方向 |
/// |-----|--------------------|-------|------|
/// | 有  | 有                 | 一致 | FVG 方向(FVG+SR 一致)|
/// | 有  | 有                 | 不一致 | FVG 方向(FVG+SR 矛盾按 FVG)|
/// | 有  | 无                 | -     | FVG 方向(无 SR 参考) |
/// | 无  | 有                 | -     | SR 方向(无 FVG 时用 SR) |
/// | 无  | 无                 | -     | None(默认 long) |
///
/// 返回四元组(方向, 时间, gap, 来源标签):
/// - 方向: true=long(只报 S)/ false=short(只报 R)
/// - 来源标签: "FVG+SR 一致" | "FVG+SR 矛盾(按 FVG long/short)" | "FVG only" | "SR only" | "NONE"
pub fn latest_fvg_direction(
    candles: &[crate::types::Candle],
    fvg_size_ratio: f64,
    options: &DetectOptions,
    fvg_lookback_count: usize,
) -> Option<(bool, i64, f64, &'static str)> {
    if candles.len() < 3 {
        return None;
    }

    // ===== 第一步:扫最近 fvg_lookback_count 根 K 找未填充 FVG =====
    // 找到就立刻记下,后面跟 SR 一起判定一致性
    // 从右往左,起点 = max(2, candles.len() - fvg_lookback_count)
    let start = candles.len().saturating_sub(fvg_lookback_count).max(2);
    let mut fvg_info: Option<(bool, i64, f64)> = None;  // (direction, time, gap)
    // 之前 `candles.len() - 1` 排除了最新 K,导致刚 close 那根 K 形成的 FVG 要滞后
    // 一个 K 才被识别(K3 是最新 K 时,c3 = candles[len-1] 永远不会被扫到)。
    // 改成 `candles.len()` — K close 后最新 K 已 finalized,可参与 FVG 判定。
    for i in (start..candles.len()).rev() {
        if i < 2 {
            break;
        }
        let c1 = &candles[i - 2];
        let c2 = &candles[i - 1]; // 中间 K
        let c3 = &candles[i];
        let range_c3_low_to_c1_high = c3.low - c1.high;
        let range_c1_low_to_c3_high = c1.low - c3.high;

        // 看涨 FVG
        if range_c3_low_to_c1_high > 0.0
            && c1.high > 0.0
            && (range_c3_low_to_c1_high / c1.high) * 100.0 >= fvg_size_ratio
        {
            // 填充判定:后续任一 K 的 low < c1.high
            let filled = (i + 1..candles.len())
                .any(|j| candles[j].low < c1.high);
            if filled {
                continue;
            }
            fvg_info = Some((true, c2.time, range_c3_low_to_c1_high));
            break;
        }

        // 看跌 FVG
        if range_c1_low_to_c3_high > 0.0
            && c1.low > 0.0
            && (range_c1_low_to_c3_high / c1.low) * 100.0 >= fvg_size_ratio
        {
            let filled = (i + 1..candles.len())
                .any(|j| candles[j].high > c1.low);
            if filled {
                continue;
            }
            fvg_info = Some((false, c2.time, range_c1_low_to_c3_high));
            break;
        }
    }

    // ===== 第二步:扫所有未戳破的 SR =====
    let srs = scan_recent_srs(candles, options, fvg_lookback_count);
    let highest_r = srs
        .iter()
        .filter(|s| s.side == "bearish")
        .max_by(|a, b| a.zone_high.partial_cmp(&b.zone_high).unwrap_or(std::cmp::Ordering::Equal));
    let lowest_s = srs
        .iter()
        .filter(|s| s.side == "bullish")
        .min_by(|a, b| a.zone_low.partial_cmp(&b.zone_low).unwrap_or(std::cmp::Ordering::Equal));

    // ===== 第三步:合并 FVG + SR,根据决策表判定方向 =====
    match (fvg_info, highest_r, lowest_s) {
        // FVG+SR 都有:必须一致
        (Some((fvg_dir, fvg_time, gap)), Some(r), Some(s)) => {
            // SR 方向:比较最高 R / 最低 S 时间戳
            let sr_dir = if r.time > s.time { false } else { true }; // R 更新→short, S 更新→long
            if fvg_dir == sr_dir {
                // 一致
                let label = if fvg_dir { "FVG+SR 一致 long" } else { "FVG+SR 一致 short" };
                Some((fvg_dir, fvg_time, gap, label))
            } else {
                // 矛盾 → 按 FVG 为准(FVG 优先于 SR)
                let label = if fvg_dir { "FVG+SR 矛盾(按 FVG long)" } else { "FVG+SR 矛盾(按 FVG short)" };
                Some((fvg_dir, fvg_time, gap, label))
            }
        }
        // 有 FVG 没 SR(有 FVG 没第二个验证)
        (Some((fvg_dir, fvg_time, gap)), _, _) => {
            Some((fvg_dir, fvg_time, gap, "FVG only"))
        }
        // 没 FVG 有 SR
        (None, Some(r), Some(s)) => {
            // 比较 SR 时间戳
            if r.time > s.time {
                Some((false, r.time, 0.0, "SR only short"))
            } else {
                Some((true, s.time, 0.0, "SR only long"))
            }
        }
        (None, Some(r), None) => Some((false, r.time, 0.0, "SR only short")),
        (None, None, Some(s)) => Some((true, s.time, 0.0, "SR only long")),
        // 都没
        (None, None, None) => None,
    }
}

/// 扫最近 N 根 K,找所有未被戳破的 wick SR zones
/// - R(阻力)未戳破:后续 K 的 high 没超过 zone_high
/// - S(支撑)未戳破:后续 K 的 low 没低于 zone_low
pub fn scan_recent_srs(
    candles: &[Candle],
    options: &DetectOptions,
    lookback_count: usize,
) -> Vec<WickSR> {
    if candles.len() < 3 {
        return Vec::new();
    }
    let start = candles.len().saturating_sub(lookback_count).max(2);
    let mut results = Vec::new();
    for i in (start..candles.len() - 1).rev() {
        if i < 2 {
            break;
        }
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

        // 上影(阻力 R)— 未被后续 K 的 high > c.high 戳破
        if upper_ratio >= options.wick_ratio {
            let broken = (i + 1..candles.len()).any(|j| candles[j].high > c.high);
            if !broken {
                let level = (body_top + c.high) / 2.0;
                results.push(WickSR {
                    time: c.time,
                    side: "bearish".to_string(),
                    level,
                    zone_low: body_top,
                    zone_high: c.high,
                    ratio: upper_ratio,
                    tier: 1,
                    index: i as i64,
                    reversal: is_reversal_wick(c, candles, "bearish", options.reversal_lookback),
                    high_quality: false,
                    high_quality_reason: String::new(),
                });
            }
        }

        // 下影(支撑 S)— 未被后续 K 的 low < c.low 戳破
        if lower_ratio >= options.wick_ratio {
            let broken = (i + 1..candles.len()).any(|j| candles[j].low < c.low);
            if !broken {
                let level = (c.low + body_bottom) / 2.0;
                results.push(WickSR {
                    time: c.time,
                    side: "bullish".to_string(),
                    level,
                    zone_low: c.low,
                    zone_high: body_bottom,
                    ratio: lower_ratio,
                    tier: 1,
                    index: i as i64,
                    reversal: is_reversal_wick(c, candles, "bullish", options.reversal_lookback),
                    high_quality: false,
                    high_quality_reason: String::new(),
                });
            }
        }
    }
    results
}

/// 1D 锚定 K 的 SR(R level + S level)
/// - R level = (body_top + high) / 2(上影中点)
/// - S level = (low + body_bottom) / 2(下影中点)
/// 不管 wick_ratio 阈值,只要上影或下影存在就出 level(wick=0 时退化为 body 端点)
/// 返回 (Option<f64>, Option<f64>)= (r_level, s_level)
pub fn sr_levels(candle: &Candle) -> (Option<f64>, Option<f64>) {
    let body_top = candle.open.max(candle.close);
    let body_bottom = candle.open.min(candle.close);
    let range = candle.high - candle.low;
    if range <= 0.0 {
        return (None, None);
    }
    let upper_wick = candle.high - body_top;
    let lower_wick = body_bottom - candle.low;
    // 不管 wick_ratio 阈值,有 wick 就出(0 时退化为 body 端点)
    let r_level = if upper_wick > 0.0 {
        Some((body_top + candle.high) / 2.0)
    } else {
        Some(body_top)  // 没上影,level = body_top
    };
    let s_level = if lower_wick > 0.0 {
        Some((candle.low + body_bottom) / 2.0)
    } else {
        Some(body_bottom)  // 没下影,level = body_bottom
    };
    (r_level, s_level)
}

/// 1D 锚定 K 完整快照(OHLC + OC mid + SR levels + time)
/// 对齐前端 DailyKPanel + wick 中点
#[derive(Clone)]
pub struct DailyAnchorData {
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub oc_mid: f64,         // (open + close) / 2
    pub r_level: Option<f64>, // wick 中点(SR 之 R)
    pub s_level: Option<f64>, // wick 中点(SR 之 S)
    pub time: i64,
}

/// 算 1D 锚定 K 完整快照(对齐前端 DailyKPanel)
/// - OHLC + 时间:从 daily_candles 找包含当前价的 K
/// - OC mid: (open + close) / 2
/// - SR levels: 跟 detect_wick_sr 公式一致(body_top+high)/2、(low+body_bottom)/2
pub fn build_daily_anchor(
    daily_candles: &[crate::types::Candle],
    current_price: f64,
) -> Option<DailyAnchorData> {
    if daily_candles.is_empty() {
        return None;
    }
    let mut anchor: Option<&crate::types::Candle> = None;
    // 对齐前端 DailyKPanel.tsx:46 findAnchor:current_price 来自 latestCandle.close(今日日 K 收盘价)
    // 但 findAnchor 从 length-2 倒序,不含最新 1D K(今日可能未收盘,范围不稳)
    if daily_candles.len() < 2 {
        return None;
    }
    for i in (0..daily_candles.len() - 1).rev() {
        let c = &daily_candles[i];
        if current_price >= c.low && current_price <= c.high {
            anchor = Some(c);
            break;
        }
    }
    let c = anchor?;
    let (r_level, s_level) = sr_levels(c);
    Some(DailyAnchorData {
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        oc_mid: (c.open + c.close) / 2.0,
        r_level,
        s_level,
        time: c.time,
    })
}

/// 双 wick 触发条件:K 线 range 上限(默认 250 USD)
/// 跟 high_quality 的 range_max_usd 对齐 — 过滤掉大 K + 长影线的伪信号
const DOUBLE_WICK_RANGE_MAX_USD: f64 = 250.0;

/// 检测最后 2 根 K(包括当前 K)的同侧 wick zone 重叠
/// 返回 HashSet<side>:
/// - "bullish" in set → 当前 K 的下影 S 跟上一根 K 的下影 S 有 zone 重叠(即"双 S"信号)
/// - "bearish" in set → 当前 K 的上影 R 跟上一根 K 的上影 R 有 zone 重叠(即"双 R"信号)
/// 重叠判定:任一(部分包含 / 被包含 / 完全包含)即算。强信号 = 同一价位被连续测试。
///
/// 额外过滤条件:
/// 1. 两 K 的实体 |open - close| 都 ≤ options.body_max_usd(默认 50 USD,doji/小实体)
/// 2. 两 K 的 range (high - low) 都 ≤ DOUBLE_WICK_RANGE_MAX_USD(默认 250 USD,K 线不能太大)
/// 这两个条件共同过滤"大 K + 长影线"的趋势性 K — 只有 doji/小实体 + 紧凑 K 才算合格信号。
pub fn detect_double_wick_last(
    candles: &[crate::types::Candle],
    options: &DetectOptions,
) -> std::collections::HashSet<String> {
    let mut result: std::collections::HashSet<String> = std::collections::HashSet::new();
    if candles.len() < 2 { return result; }
    let prev_c = &candles[candles.len() - 2];
    let curr_c = &candles[candles.len() - 1];
    let range_prev = prev_c.high - prev_c.low;
    let range_curr = curr_c.high - curr_c.low;
    if range_prev <= 0.0 || range_curr <= 0.0 { return result; }

    // 实体(body)过滤:两 K 都 ≤ body_max_usd(默认 50 USD,doji/小实体)
    let prev_body_size = (prev_c.open - prev_c.close).abs();
    let curr_body_size = (curr_c.open - curr_c.close).abs();
    if prev_body_size > options.body_max_usd || curr_body_size > options.body_max_usd {
        return result;
    }
    // K 线 range 过滤:两 K 都 ≤ DOUBLE_WICK_RANGE_MAX_USD(默认 200 USD)
    if range_prev > DOUBLE_WICK_RANGE_MAX_USD || range_curr > DOUBLE_WICK_RANGE_MAX_USD {
        return result;
    }

    // 上一根 K 的 wick ratio
    let prev_body_top = prev_c.open.max(prev_c.close);
    let prev_body_bottom = prev_c.open.min(prev_c.close);
    let prev_upper_ratio = (prev_c.high - prev_body_top) / range_prev;
    let prev_lower_ratio = (prev_body_bottom - prev_c.low) / range_prev;
    // 当前 K 的 wick ratio
    let curr_body_top = curr_c.open.max(curr_c.close);
    let curr_body_bottom = curr_c.open.min(curr_c.close);
    let curr_upper_ratio = (curr_c.high - curr_body_top) / range_curr;
    let curr_lower_ratio = (curr_body_bottom - curr_c.low) / range_curr;

    // 双 S:两 K 都有 ≥ wick_ratio 的下影,且 zone 重叠
    // S zone = [c.low, body_bottom];重叠 ⇔ curr.low ≤ prev.body_bottom && prev.low ≤ curr.body_bottom
    // 两 K 必须两边都有影线(> 0)— 排除光头 K,代表双方激烈争夺
    // 两边的影线都 > body(实体)— 双方争夺激烈,影线大于实体
    let prev_both_sides = prev_lower_ratio > 0.0 && prev_upper_ratio > 0.0;
    let curr_both_sides = curr_lower_ratio > 0.0 && curr_upper_ratio > 0.0;
    let prev_wicks_gt_body = prev_lower_ratio * range_prev > prev_body_size
        && prev_upper_ratio * range_prev > prev_body_size;
    let curr_wicks_gt_body = curr_lower_ratio * range_curr > curr_body_size
        && curr_upper_ratio * range_curr > curr_body_size;
    if prev_both_sides && curr_both_sides
        && prev_wicks_gt_body && curr_wicks_gt_body
        && prev_lower_ratio >= options.wick_ratio && curr_lower_ratio >= options.wick_ratio
    {
        if curr_c.low <= prev_body_bottom && prev_c.low <= curr_body_bottom {
            result.insert("bullish".to_string());
        }
    }
    // 双 R:两 K 都有 ≥ wick_ratio 的上影,且 zone 重叠
    // R zone = [body_top, c.high];重叠 ⇔ curr.body_top ≤ prev.high && prev.body_top ≤ curr.high
    if prev_both_sides && curr_both_sides
        && prev_wicks_gt_body && curr_wicks_gt_body
        && prev_upper_ratio >= options.wick_ratio && curr_upper_ratio >= options.wick_ratio
    {
        if curr_body_top <= prev_c.high && prev_body_top <= curr_c.high {
            result.insert("bearish".to_string());
        }
    }
    result
}
