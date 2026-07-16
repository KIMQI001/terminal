//! Pinbar 检测数据结构

use serde::{Deserialize, Serialize};

/// K线数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candle {
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

/// Swing Point 类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwingPoint {
    /// "high" | "low"
    pub swing_type: String,
    pub price: f64,
    pub time: i64,
    pub index: usize,
    /// "HH" | "HL" | "LH" | "LL"
    pub classification: String,
}

/// Pinbar 信号
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinbarSignal {
    /// "bullish" | "bearish"
    pub signal_type: String,
    /// K线时间（秒）
    pub time: i64,
    pub price: f64,
    pub body_size: f64,
    pub top_wick_size: f64,
    pub bottom_wick_size: f64,
    /// 最近的 Swing Point 类型
    pub near_swing: String,
    /// 信号强度评分
    pub strength: f64,
}

/// Pinbar 更新消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinbarUpdate {
    pub symbol: String,
    pub timeframe: String,
    pub signals: Vec<PinbarSignal>,
    pub swing_points: Vec<SwingPoint>,
}

/// FVG (Fair Value Gap) 信号
/// Bullish: candle1.high < candle3.low (中间 K 线向上跳空)
/// Bearish: candle1.low > candle3.high (中间 K 线向下跳空)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FVG {
    /// "bullish" | "bearish"
    pub fvg_type: String,
    /// FVG 上边界（看涨=gap顶部，看跌=c1.low）
    pub high: f64,
    /// FVG 下边界（看涨=c1.high，看跌=gap底部）
    pub low: f64,
    /// 形成时间戳（中间 K 线 candle2.time）
    pub time: i64,
    /// Gap 绝对大小
    pub gap_size: f64,
    /// Gap 百分比（相对 c1.high 或 c1.low）
    pub gap_percent: f64,
}