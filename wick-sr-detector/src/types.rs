//! Wick SR 检测数据类型

use serde::{Deserialize, Serialize};

/// 单根 K 线
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candle {
    pub time: i64,    // 秒
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

/// Swing point(用于 HH/HL/LH/LL 分类,tier 计算用)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwingPoint {
    pub kind: String,         // "high" | "low"
    pub price: f64,
    pub time: i64,
    pub index: i64,
    pub classification: Option<String>,  // "HH" | "HL" | "LH" | "LL"
}

/// 一个 wick 形成的供给/需求区
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WickSR {
    /// K close time(秒)
    pub time: i64,
    /// bullish=下影/支撑, bearish=上影/阻力
    pub side: String,
    /// wick 段的中点(可入场位)
    pub level: f64,
    /// 来源 wick 段
    /// bullish: [low, bodyBottom]; bearish: [bodyTop, high]
    pub zone_low: f64,
    pub zone_high: f64,
    /// wick 占整 K range 的比例
    pub ratio: f64,
    /// 层级:R1/R2 或 S1/S2 — 看上一根 wick 类型
    pub tier: u32,
    /// 上一根 K 索引
    pub index: i64,
    /// 是否反转 wick:R 突破前高(看跌反转) / S 跌破前低(看涨反转)
    pub reversal: bool,
    /// 高等级信号:R 在阳 K / S 在阴 K(收不回 → 收盘价入场)
    pub high_quality: bool,
}
