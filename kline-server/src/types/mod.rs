//! K线数据类型定义

use serde::{Deserialize, Serialize};
use std::fmt;

/// 交易所类型枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExchangeType {
    #[default]
    Binance,
    Okx,
    Bybit,
    // DEX 预留
    // Uniswap,
    // Raydium,
    // Jupiter,
}

impl ExchangeType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ExchangeType::Binance => "binance",
            ExchangeType::Okx => "okx",
            ExchangeType::Bybit => "bybit",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "binance" => Some(ExchangeType::Binance),
            "okx" => Some(ExchangeType::Okx),
            "bybit" => Some(ExchangeType::Bybit),
            _ => None,
        }
    }
}

impl fmt::Display for ExchangeType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

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
    #[serde(rename = "4d")]
    D4,
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
            Timeframe::D4 => "4d",
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
            Timeframe::D4 => 4 * 24 * 60 * 60,
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
            "4d" => Some(Timeframe::D4),
            "1w" => Some(Timeframe::W1),
            _ => None,
        }
    }

    /// 是否需要从基础周期聚合（Binance 不原生支持）
    pub fn needs_aggregation(&self) -> bool {
        matches!(self, Timeframe::D4)
    }

    /// 返回聚合所需的基础时间周期
    pub fn base_timeframe(&self) -> Timeframe {
        match self {
            Timeframe::D4 => Timeframe::D1,
            _ => *self,
        }
    }

    /// 返回聚合所需的基础周期数量
    pub fn aggregation_count(&self) -> usize {
        match self {
            Timeframe::D4 => 4,
            _ => 1,
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

/// 将多根基础K线聚合为一根更高时间周期的K线
///
/// # 参数
/// - klines: 基础K线数组（必须按时间升序排列）
/// - target_timeframe: 目标时间周期
/// - count: 聚合数量（如 4D 需要 4 根 1D）
///
/// # 返回
/// 聚合后的K线数组
pub fn aggregate_klines(klines: &[Kline], target_timeframe: &str, count: usize) -> Vec<Kline> {
    if klines.is_empty() || count == 0 {
        return Vec::new();
    }

    let mut result = Vec::new();
    let chunks = klines.chunks(count);

    for chunk in chunks {
        if chunk.is_empty() {
            continue;
        }

        let first = &chunk[0];
        let last = chunk.last().unwrap();

        // 聚合OHLCV
        let open = first.open;
        let close = last.close;
        let high = chunk.iter().map(|k| k.high).fold(f64::NEG_INFINITY, f64::max);
        let low = chunk.iter().map(|k| k.low).fold(f64::INFINITY, f64::min);
        let volume: f64 = chunk.iter().map(|k| k.volume).sum();
        let quote_volume: f64 = chunk.iter().map(|k| k.quote_volume).sum();
        let trades: i64 = chunk.iter().map(|k| k.trades).sum();

        // 只有当所有子K线都收盘时，聚合K线才算收盘
        let is_closed = chunk.len() == count && chunk.iter().all(|k| k.is_closed);

        result.push(Kline {
            symbol: first.symbol.clone(),
            timeframe: target_timeframe.to_string(),
            open_time: first.open_time,
            open,
            high,
            low,
            close,
            volume,
            close_time: last.close_time,
            quote_volume,
            trades,
            is_closed,
        });
    }

    result
}

/// 计算4D K线的起始时间
/// 以 UTC 2020-01-01 为锚点，每4天为一个周期
///
/// 注意：4D 聚合使用 UTC 锚点，与前端上海时区显示不同。
/// 这是设计选择，因为：
/// 1. 4D 主要用于指标计算（P/D 区域），不直接用于时间显示
/// 2. 保持与 Binance 原始数据的 UTC 一致性
/// 3. 避免夏令时导致的周期边界混乱
pub fn get_4d_period_start(timestamp_secs: i64) -> i64 {
    // 2020-01-01 00:00:00 UTC = 1577836800
    const ANCHOR: i64 = 1577836800;
    const PERIOD_SECS: i64 = 4 * 24 * 60 * 60; // 4天

    let elapsed = timestamp_secs - ANCHOR;
    let periods = elapsed / PERIOD_SECS;
    ANCHOR + periods * PERIOD_SECS
}

/// 将1D K线按4D周期分组并聚合
pub fn aggregate_to_4d(daily_klines: &[Kline]) -> Vec<Kline> {
    if daily_klines.is_empty() {
        return Vec::new();
    }

    // 按4D周期分组
    let mut grouped: std::collections::BTreeMap<i64, Vec<&Kline>> = std::collections::BTreeMap::new();

    for kline in daily_klines {
        let period_start = get_4d_period_start(kline.open_time);
        grouped.entry(period_start).or_default().push(kline);
    }

    // 聚合每个周期
    let mut result = Vec::new();
    for (period_start, klines) in grouped {
        if klines.is_empty() {
            continue;
        }

        // 按时间排序
        let mut sorted_klines: Vec<_> = klines;
        sorted_klines.sort_by_key(|k| k.open_time);

        let first = sorted_klines[0];
        let last = sorted_klines.last().unwrap();

        let open = first.open;
        let close = last.close;
        let high = sorted_klines.iter().map(|k| k.high).fold(f64::NEG_INFINITY, f64::max);
        let low = sorted_klines.iter().map(|k| k.low).fold(f64::INFINITY, f64::min);
        let volume: f64 = sorted_klines.iter().map(|k| k.volume).sum();
        let quote_volume: f64 = sorted_klines.iter().map(|k| k.quote_volume).sum();
        let trades: i64 = sorted_klines.iter().map(|k| k.trades).sum();

        // 4D周期收盘：需要4根1D K线且最后一根已收盘
        let is_closed = sorted_klines.len() == 4 && last.is_closed;

        result.push(Kline {
            symbol: first.symbol.clone(),
            timeframe: "4d".to_string(),
            open_time: period_start,
            open,
            high,
            low,
            close,
            volume,
            close_time: period_start + 4 * 24 * 60 * 60 - 1,
            quote_volume,
            trades,
            is_closed,
        });
    }

    result
}
