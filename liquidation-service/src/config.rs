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
}

impl Config {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let content = fs::read_to_string(path)?;
        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }
}
