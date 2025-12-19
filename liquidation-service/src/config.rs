use serde::Deserialize;
use std::collections::HashMap;
use std::fs;

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub server: ServerConfig,
    pub binance: BinanceConfig,
    pub calculation: CalculationConfig,
    pub leverage: LeverageConfig,
    pub storage: StorageConfig,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Deserialize, Clone)]
pub struct BinanceConfig {
    pub base_url: String,
    pub ws_url: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CalculationConfig {
    pub kline_interval: String,
    pub lookback_days: u32,
    pub price_bucket_size: f64,
    pub symbols: Vec<String>,
    /// 持仓留存率：成交量中留存为持仓的比例
    /// 默认 0.4，即假设 40% 的成交量最终形成持仓
    #[serde(default = "default_retention_rate")]
    pub retention_rate: f64,
}

fn default_retention_rate() -> f64 {
    0.4
}

#[derive(Debug, Deserialize, Clone)]
pub struct LeverageConfig {
    pub default_distribution: HashMap<String, f64>,  // "lev_10" -> 0.15
    pub use_dynamic: bool,
}

impl LeverageConfig {
    /// 将 "lev_10" -> 0.15 格式转换为 10 -> 0.15
    pub fn get_parsed_distribution(&self) -> HashMap<u32, f64> {
        self.default_distribution
            .iter()
            .filter_map(|(k, v)| {
                k.strip_prefix("lev_")
                    .and_then(|s| s.parse::<u32>().ok())
                    .map(|leverage| (leverage, *v))
            })
            .collect()
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct StorageConfig {
    pub db_path: String,
    /// 数据保留时长（小时），默认 30 小时
    #[serde(default = "default_retention_hours")]
    pub retention_hours: u32,
}

fn default_retention_hours() -> u32 {
    30
}

impl Config {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let content = fs::read_to_string(path)?;
        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }
}
