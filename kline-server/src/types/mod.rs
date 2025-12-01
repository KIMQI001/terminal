//! K线数据类型定义

use serde::{Deserialize, Serialize};

/// K线数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Kline {
    pub symbol: String,
    pub timeframe: String,
    pub open_time: i64,    // Unix 时间戳（秒）
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub close_time: i64,
    pub quote_volume: f64,
    pub trades: i64,
    pub is_closed: bool,
}

/// 前端使用的简化 K 线格式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KlineSimple {
    pub time: i64,      // open_time
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

impl From<Kline> for KlineSimple {
    fn from(k: Kline) -> Self {
        Self {
            time: k.open_time,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume,
        }
    }
}

impl From<&Kline> for KlineSimple {
    fn from(k: &Kline) -> Self {
        Self {
            time: k.open_time,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume,
        }
    }
}

/// 支持的时间周期
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Timeframe {
    #[serde(rename = "1m")]
    M1,
    #[serde(rename = "5m")]
    M5,
    #[serde(rename = "15m")]
    M15,
    #[serde(rename = "1h")]
    H1,
    #[serde(rename = "4h")]
    H4,
    #[serde(rename = "1d")]
    D1,
    #[serde(rename = "1w")]
    W1,
}

impl Timeframe {
    /// 返回时间周期的字符串表示
    pub fn as_str(&self) -> &'static str {
        match self {
            Timeframe::M1 => "1m",
            Timeframe::M5 => "5m",
            Timeframe::M15 => "15m",
            Timeframe::H1 => "1h",
            Timeframe::H4 => "4h",
            Timeframe::D1 => "1d",
            Timeframe::W1 => "1w",
        }
    }

    /// 返回时间周期的秒数
    pub fn seconds(&self) -> i64 {
        match self {
            Timeframe::M1 => 60,
            Timeframe::M5 => 5 * 60,
            Timeframe::M15 => 15 * 60,
            Timeframe::H1 => 60 * 60,
            Timeframe::H4 => 4 * 60 * 60,
            Timeframe::D1 => 24 * 60 * 60,
            Timeframe::W1 => 7 * 24 * 60 * 60,
        }
    }

    /// 从字符串解析时间周期
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "1m" => Some(Timeframe::M1),
            "5m" => Some(Timeframe::M5),
            "15m" => Some(Timeframe::M15),
            "1h" => Some(Timeframe::H1),
            "4h" => Some(Timeframe::H4),
            "1d" => Some(Timeframe::D1),
            "1w" => Some(Timeframe::W1),
            _ => None,
        }
    }
}

impl std::fmt::Display for Timeframe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// WebSocket 消息类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum WsMessage {
    /// 订阅请求
    Subscribe { symbol: String, timeframe: String },
    /// 取消订阅
    Unsubscribe { symbol: String, timeframe: String },
    /// K线更新
    KlineUpdate(KlineSimple),
    /// 历史K线数据（初次订阅时发送）
    KlineHistory { symbol: String, timeframe: String, klines: Vec<KlineSimple> },
    /// 错误消息
    Error { message: String },
    /// Ping/Pong
    Ping,
    Pong,
}

/// 订阅键（用于标识唯一订阅）
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SubscriptionKey {
    pub symbol: String,
    pub timeframe: String,
}

impl SubscriptionKey {
    pub fn new(symbol: impl Into<String>, timeframe: impl Into<String>) -> Self {
        Self {
            symbol: symbol.into().to_uppercase(),
            timeframe: timeframe.into().to_lowercase(),
        }
    }
}

impl std::fmt::Display for SubscriptionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}@{}", self.symbol, self.timeframe)
    }
}
