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