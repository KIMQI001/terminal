use serde::Deserialize;
use std::fs;
use anyhow::Result;

/// 交易方向
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Long,   // 做多：价格下方挂买单
    Short,  // 做空：价格上方挂卖单
}

impl Default for Direction {
    fn default() -> Self {
        Direction::Long
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub binance: BinanceConfig,
    pub grid: GridConfig,
    pub rolling: RollingConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BinanceConfig {
    pub api_key: String,
    pub api_secret: String,
    #[serde(default = "default_api_url")]
    pub api_url: String,
    #[serde(default = "default_ws_url")]
    pub ws_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GridConfig {
    pub symbol: String,
    #[serde(default)]
    pub direction: Direction,       // 交易方向: long/short
    #[serde(default = "default_grid_spacing")]
    pub grid_spacing: f64,          // 网格间距 (USDT)
    #[serde(default = "default_grid_count")]
    pub grid_count: u32,            // 网格数量
    #[serde(default = "default_order_margin")]
    pub order_margin: f64,          // 每单保证金 (USDT)
    #[serde(default = "default_max_margin")]
    pub max_margin: f64,            // 最大保证金 (USDT)
    #[serde(default = "default_leverage")]
    pub leverage: u32,              // 杠杆倍数
    #[serde(default = "default_price_precision")]
    pub price_precision: u32,       // 价格精度
    #[serde(default = "default_qty_precision")]
    pub quantity_precision: u32,    // 数量精度
}

#[derive(Debug, Clone, Deserialize)]
pub struct RollingConfig {
    pub target_price: f64,          // 目标价位 = 止盈价 (必填)
    #[serde(default = "default_stop_loss_percent")]
    pub stop_loss_percent: f64,     // 止损百分比 (如 5.0 表示 5%)，0 表示不设止损
    #[serde(default = "default_use_rolling_margin")]
    pub use_rolling_margin: bool,   // 是否用浮盈滚仓
    #[serde(default = "default_roll_profit_ratio")]
    pub roll_profit_ratio: f64,     // 滚仓比例 (如 100.0 表示 100% 浮盈用于滚仓)
    #[serde(default = "default_start_roll_distance")]
    pub start_roll_distance: f64,   // 开始补单距离 (%)，盈利达到此比例后开始补单
    #[serde(default = "default_stop_roll_distance")]
    pub stop_roll_distance: f64,    // 停止补单距离 (%)，接近目标价时停止补单
}

// 默认值函数
fn default_api_url() -> String { "https://fapi.binance.com".to_string() }
fn default_ws_url() -> String { "wss://fstream.binance.com/ws".to_string() }
fn default_grid_spacing() -> f64 { 1.0 }
fn default_grid_count() -> u32 { 10 }
fn default_order_margin() -> f64 { 10.0 }   // 每单保证金 10 USDT
fn default_max_margin() -> f64 { 100.0 }    // 最大保证金 100 USDT
fn default_leverage() -> u32 { 10 }
fn default_price_precision() -> u32 { 2 }
fn default_qty_precision() -> u32 { 3 }
fn default_stop_loss_percent() -> f64 { 0.0 }
fn default_use_rolling_margin() -> bool { false }
fn default_roll_profit_ratio() -> f64 { 100.0 }
fn default_start_roll_distance() -> f64 { 0.0 }  // 默认立即开始补单
fn default_stop_roll_distance() -> f64 { 1.0 }   // 默认距离目标价 1% 停止补单

impl Config {
    pub fn load(path: &str) -> Result<Self> {
        let content = fs::read_to_string(path)?;
        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }
}
