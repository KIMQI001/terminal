/**
 * Swing Point 检测 + 「最长波段」框架计算
 *
 * 与前端 src/lib/chart/indicators/pivotDetector.ts + src/components/chart/LongestSwingPanel.tsx
 * 严格对齐(Rust 侧复刻),保证服务端算出来的 6 个价位与面板上看到的完全一致。
 *
 * 关键点:
 * - pivot 的 index / time = pivot 本根 K 线(不是确认那根)
 * - 触发 K 线:从 HH / LL **左边**扫,取第一根符合颜色的 K 线
 * - 已触发(红框):从 HH / LL **之后**开始,后续 K 线区间"遮挡"该价位
 */

use crate::types::{Candle, Frame, Leg, Level, LevelKind, PivotType, Side, SwingPoint};

// 图上最多画 5 条 swing high 射线 + 5 条 swing low 射线
pub const SWING_RAY_COUNT: usize = 5;
// classifyPivots 的默认最小摆动幅度过滤(%)
pub const MIN_SWING_PERCENT: f64 = 0.5;

/// HH / HL / LH / LL 分类
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwingClass {
    Hh,
    Hl,
    Lh,
    Ll,
}

impl SwingClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            SwingClass::Hh => "HH",
            SwingClass::Hl => "HL",
            SwingClass::Lh => "LH",
            SwingClass::Ll => "LL",
        }
    }
}

/// 带分类的 swing point
#[derive(Clone, Debug)]
pub struct ClassifiedSwing {
    pub pivot_type: PivotType,
    pub price: f64,
    pub time: i64,
    pub index: usize,
    pub classification: SwingClass,
}

/// 各周期的 swing 回溯长度(与前端 TradingChart.getSwingLookback 一致)
pub fn swing_length_for(timeframe: &str) -> usize {
    match timeframe {
        "1m" => 30,
        "5m" => 30,
        "15m" => 20,
        "1h" => 24,
        "4h" => 30,
        "1d" => 30,
        _ => 50,
    }
}

// ============== Pivot 检测 ==============

/// TradingView ta.pivothigh:bar i 本身是 pivot high(左侧严格小于,右侧允许等于)
fn ta_pivot_high(candles: &[Candle], i: usize, length: usize) -> Option<f64> {
    if i < length {
        return None;
    }
    let is_high = candles[i].high;
    for j in 1..=length {
        if candles[i - j].high > is_high {
            return None;
        }
    }
    for j in 1..length {
        if i + j < candles.len() && candles[i + j].high >= is_high {
            return None;
        }
    }
    Some(is_high)
}

/// TradingView ta.pivotlow
fn ta_pivot_low(candles: &[Candle], i: usize, length: usize) -> Option<f64> {
    if i < length {
        return None;
    }
    let is_low = candles[i].low;
    for j in 1..=length {
        if candles[i - j].low < is_low {
            return None;
        }
    }
    for j in 1..length {
        if i + j < candles.len() && candles[i + j].low <= is_low {
            return None;
        }
    }
    Some(is_low)
}

/// 检测常规 pivot(与前端 detectPivots 的 pivots 部分一致)
pub fn detect_pivots(candles: &[Candle], length: usize) -> Vec<(PivotType, f64, i64, usize)> {
    let mut pivots = Vec::new();
    if candles.len() < length + 1 {
        return pivots;
    }
    for i in length..candles.len() {
        if let Some(ph) = ta_pivot_high(candles, i, length) {
            pivots.push((PivotType::High, ph, candles[i].time, i));
        }
        if let Some(pl) = ta_pivot_low(candles, i, length) {
            pivots.push((PivotType::Low, pl, candles[i].time, i));
        }
    }
    pivots
}

/// HH/HL/LH/LL 分类(前端 classifyPivotsNew)
fn classify_pivots(pivots: &[(PivotType, f64, i64, usize)]) -> Vec<ClassifiedSwing> {
    let mut result: Vec<ClassifiedSwing> = Vec::with_capacity(pivots.len());
    let mut last_high_price = 0.0f64;
    let mut last_low_price = f64::INFINITY;

    for (pivot_type, price, time, index) in pivots {
        let classification = match pivot_type {
            PivotType::High => {
                let c = if last_high_price == 0.0 {
                    SwingClass::Lh
                } else if *price > last_high_price {
                    SwingClass::Hh
                } else {
                    SwingClass::Lh
                };
                last_high_price = *price;
                c
            }
            PivotType::Low => {
                let c = if last_low_price.is_infinite() {
                    SwingClass::Ll
                } else if *price > last_low_price {
                    SwingClass::Hl
                } else {
                    SwingClass::Ll
                };
                last_low_price = *price;
                c
            }
        };
        result.push(ClassifiedSwing {
            pivot_type: *pivot_type,
            price: *price,
            time: *time,
            index: *index,
            classification,
        });
    }
    result
}

/// 按最小摆动幅度过滤(前端 filterBySwingPercent,默认 0.5%)
fn filter_by_swing_percent(pivots: Vec<ClassifiedSwing>, min_pct: f64) -> Vec<ClassifiedSwing> {
    let mut result = Vec::new();
    let mut last_high_price = 0.0f64;
    let mut last_low_price = f64::INFINITY;

    for p in pivots {
        let price = p.price;
        match p.pivot_type {
            PivotType::High => {
                if last_high_price == 0.0 {
                    result.push(p);
                } else {
                    let change = (price - last_high_price).abs() / last_high_price * 100.0;
                    if change >= min_pct {
                        result.push(p);
                    }
                }
                last_high_price = price;
            }
            PivotType::Low => {
                if last_low_price.is_infinite() {
                    result.push(p);
                } else {
                    let change = (price - last_low_price).abs() / last_low_price * 100.0;
                    if change >= min_pct {
                        result.push(p);
                    }
                }
                last_low_price = price;
            }
        }
    }
    result
}

/// 完整的 swing point 计算(pivot + 分类 + 过滤),与前端 store 里的 swingPoints 一致
pub fn compute_swing_points(candles: &[Candle], length: usize) -> Vec<ClassifiedSwing> {
    let pivots = detect_pivots(candles, length);
    let classified = classify_pivots(&pivots);
    filter_by_swing_percent(classified, MIN_SWING_PERCENT)
}

// ============== 波段(leg) ==============

/// 一条波段
#[derive(Clone, Debug)]
pub struct SwingLeg {
    pub from: SwingPoint,
    pub to: SwingPoint,
    pub change: f64,
    pub percent: f64,
    pub amplitude: f64,
    pub bars: usize,
    pub duration_sec: i64,
    pub up: bool,
}

/// 由 swing points 切出所有波段(相邻的一高一低)
pub fn build_legs(swings: &[ClassifiedSwing]) -> Vec<SwingLeg> {
    let mut highs: Vec<ClassifiedSwing> = swings
        .iter()
        .filter(|s| s.pivot_type == PivotType::High)
        .cloned()
        .collect();
    let mut lows: Vec<ClassifiedSwing> = swings
        .iter()
        .filter(|s| s.pivot_type == PivotType::Low)
        .cloned()
        .collect();

    // 只保留最近 SWING_RAY_COUNT 个
    if highs.len() > SWING_RAY_COUNT {
        highs.drain(0..highs.len() - SWING_RAY_COUNT);
    }
    if lows.len() > SWING_RAY_COUNT {
        lows.drain(0..lows.len() - SWING_RAY_COUNT);
    }

    let mut points: Vec<ClassifiedSwing> = highs;
    points.extend(lows);
    points.sort_by(|a, b| a.time.cmp(&b.time)); // 稳定排序,与 JS 一致

    let mut result = Vec::new();
    for i in 0..points.len().saturating_sub(1) {
        let from = &points[i];
        let to = &points[i + 1];
        if from.pivot_type == to.pivot_type {
            continue; // 同类型相邻,不是波段
        }
        let change = to.price - from.price;
        result.push(SwingLeg {
            from: SwingPoint {
                pivot_type: from.pivot_type,
                price: from.price,
                time: from.time,
                index: from.index,
            },
            to: SwingPoint {
                pivot_type: to.pivot_type,
                price: to.price,
                time: to.time,
                index: to.index,
            },
            change,
            percent: if from.price != 0.0 {
                change / from.price * 100.0
            } else {
                0.0
            },
            amplitude: change.abs(),
            bars: to.index.saturating_sub(from.index),
            duration_sec: (to.time - from.time).max(0),
            up: change > 0.0,
        });
    }
    result
}

fn leg_to_types(leg: &SwingLeg) -> Leg {
    Leg {
        from: leg.from.clone(),
        to: leg.to.clone(),
        change: leg.change,
        percent: leg.percent,
        amplitude: leg.amplitude,
        bars: leg.bars,
        duration_sec: leg.duration_sec,
        up: leg.up,
    }
}

// ============== 触发 K 线 / 覆盖 ==============

/// 射线向左扫到的触发 K 线
#[derive(Clone, Debug)]
pub struct TriggerCandle {
    pub candle: Candle,
    /// 该 K 线在 pivot 左边多少根
    pub distance: usize,
    /// 该 K 线下标
    pub index: usize,
}

/// 沿**向左的虚射线**找触发 K 线
/// - bullish_below: HH 射线扫到的第一根**阳线**
/// - bearish_above: LL 射线扫到的第一根**阴线**
pub fn find_ray_trigger(
    candles: &[Candle],
    pivot_idx: usize,
    pivot_price: f64,
    bullish_below: bool,
) -> Option<TriggerCandle> {
    if pivot_idx == 0 {
        return None;
    }
    for j in (0..pivot_idx).rev() {
        let c = &candles[j];
        // 射线没扫到这根 K(价格区间不覆盖该价位)
        if c.low > pivot_price || c.high < pivot_price {
            continue;
        }
        let bull = c.close > c.open;
        let bear = c.close < c.open;
        let matched = if bullish_below { bull } else { bear };
        if matched {
            return Some(TriggerCandle {
                candle: c.clone(),
                distance: pivot_idx - j,
                index: j,
            });
        }
    }
    None
}

/// 从 `from_idx` 之后开始,给每个价位向右发水平射线,看后续 K 线有没有"遮挡"它
/// 返回 (label, 是否覆盖, 最早覆盖时间)
pub fn find_level_coverage(
    candles: &[Candle],
    from_idx: usize,
    levels: &[(String, f64)],
) -> Vec<(String, bool, Option<i64>)> {
    let mut covered = vec![false; levels.len()];
    let mut hit_time = vec![None; levels.len()];

    for j in (from_idx + 1)..candles.len() {
        let c = &candles[j];
        let mut all = true;
        for (i, (_label, price)) in levels.iter().enumerate() {
            if covered[i] {
                continue;
            }
            if c.low <= *price && *price <= c.high {
                covered[i] = true;
                hit_time[i] = Some(c.time);
            } else {
                all = false;
            }
        }
        if all {
            break;
        }
    }

    levels
        .iter()
        .enumerate()
        .map(|(i, (label, _))| (label.clone(), covered[i], hit_time[i]))
        .collect()
}

/// 找到 pivot 对应的 K 线下标(按时间戳匹配,匹配不到再用 pivot.index 兜底)
fn find_candle_index(candles: &[Candle], pivot: &SwingPoint) -> Option<usize> {
    if let Some(idx) = candles.iter().position(|c| c.time == pivot.time) {
        return Some(idx);
    }
    if pivot.index < candles.len() {
        return Some(pivot.index);
    }
    None
}

// ============== 框架 ==============

/// 计算当前「最长波段」框架
///
/// - 主行:幅度最大的波段
/// - 副行:持续时间最长的波段(与主行不同才为 Some)
/// - 6 个价位:阳O/阳H/阳C(做空)、阴O/阴L/阴C(做多),并标注是否已被触发
pub fn compute_frame(candles: &[Candle], timeframe: &str) -> Option<Frame> {
    let swings = compute_swing_points(candles, swing_length_for(timeframe));
    let legs = build_legs(&swings);
    if legs.is_empty() {
        return None;
    }

    // 幅度最大(第一个最大值胜出,与 JS reduce 一致)
    let mut amp_idx = 0usize;
    for (i, l) in legs.iter().enumerate() {
        if l.amplitude > legs[amp_idx].amplitude {
            amp_idx = i;
        }
    }
    // 持续最久
    let mut dur_idx = 0usize;
    for (i, l) in legs.iter().enumerate() {
        if l.duration_sec > legs[dur_idx].duration_sec {
            dur_idx = i;
        }
    }

    let leg = &legs[amp_idx];
    let hh = if leg.from.pivot_type == PivotType::High {
        leg.from.clone()
    } else {
        leg.to.clone()
    };
    let ll = if leg.from.pivot_type == PivotType::Low {
        leg.from.clone()
    } else {
        leg.to.clone()
    };

    let hh_idx = find_candle_index(candles, &hh);
    let ll_idx = find_candle_index(candles, &ll);

    // —— 阳线行(HH 射线向左第一根阳线,做空) ——
    let mut bull_levels: Vec<Level> = Vec::new();
    if let Some(hidx) = hh_idx {
        if let Some(trigger) = find_ray_trigger(candles, hidx, hh.price, true) {
            let raw = [
                ("阳O".to_string(), trigger.candle.open),
                ("阳H".to_string(), trigger.candle.high),
                ("阳C".to_string(), trigger.candle.close),
            ];
            let coverage = find_level_coverage(candles, hidx, &raw);
            for (i, (label, price)) in raw.iter().enumerate() {
                bull_levels.push(Level {
                    label: label.clone(),
                    price: *price,
                    side: Side::Sell,
                    kind: LevelKind::Bull,
                    pivot_label: "HH".to_string(),
                    covered: coverage[i].1,
                    covered_at: coverage[i].2,
                });
            }
        }
    }

    // —— 阴线行(LL 射线向左第一根阴线,做多) ——
    let mut bear_levels: Vec<Level> = Vec::new();
    if let Some(lidx) = ll_idx {
        if let Some(trigger) = find_ray_trigger(candles, lidx, ll.price, false) {
            let raw = [
                ("阴O".to_string(), trigger.candle.open),
                ("阴L".to_string(), trigger.candle.low),
                ("阴C".to_string(), trigger.candle.close),
            ];
            let coverage = find_level_coverage(candles, lidx, &raw);
            for (i, (label, price)) in raw.iter().enumerate() {
                bear_levels.push(Level {
                    label: label.clone(),
                    price: *price,
                    side: Side::Buy,
                    kind: LevelKind::Bear,
                    pivot_label: "LL".to_string(),
                    covered: coverage[i].1,
                    covered_at: coverage[i].2,
                });
            }
        }
    }

    let duration_leg = if dur_idx == amp_idx {
        None
    } else {
        Some(leg_to_types(&legs[dur_idx]))
    };

    Some(Frame {
        leg: leg_to_types(leg),
        duration_leg,
        hh,
        ll,
        hh_index: hh_idx.unwrap_or(0),
        ll_index: ll_idx.unwrap_or(0),
        bull_levels,
        bear_levels,
    })
}
