use anyhow::Result;
use serde::{Deserialize, Serialize};

/// K线数据结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Kline {
    pub open_time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,           // 成交量 (BTC)
    pub quote_volume: f64,     // 成交额 (USDT)
    pub close_time: i64,
    pub trades: u64,
}

/// Binance K线 API 客户端
pub struct BinanceKlineClient {
    base_url: String,
    client: reqwest::Client,
}

impl BinanceKlineClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// 获取 K线数据
    /// interval: 1m, 5m, 15m, 1h, 4h, 1d 等
    /// limit: 最多 1500
    pub async fn get_klines(
        &self,
        symbol: &str,
        interval: &str,
        limit: u32,
    ) -> Result<Vec<Kline>> {
        let url = format!(
            "{}/fapi/v1/klines?symbol={}&interval={}&limit={}",
            self.base_url, symbol, interval, limit
        );

        let response = self.client.get(&url).send().await?;
        let data: Vec<Vec<serde_json::Value>> = response.json().await?;

        let klines = data
            .into_iter()
            .map(|k| Kline {
                open_time: k[0].as_i64().unwrap_or(0),
                open: k[1].as_str().unwrap_or("0").parse().unwrap_or(0.0),
                high: k[2].as_str().unwrap_or("0").parse().unwrap_or(0.0),
                low: k[3].as_str().unwrap_or("0").parse().unwrap_or(0.0),
                close: k[4].as_str().unwrap_or("0").parse().unwrap_or(0.0),
                volume: k[5].as_str().unwrap_or("0").parse().unwrap_or(0.0),
                quote_volume: k[7].as_str().unwrap_or("0").parse().unwrap_or(0.0),
                close_time: k[6].as_i64().unwrap_or(0),
                trades: k[8].as_u64().unwrap_or(0),
            })
            .collect();

        Ok(klines)
    }

    /// 获取当前价格
    pub async fn get_price(&self, symbol: &str) -> Result<f64> {
        let url = format!("{}/fapi/v1/ticker/price?symbol={}", self.base_url, symbol);
        let response = self.client.get(&url).send().await?;

        #[derive(Deserialize)]
        struct PriceResponse {
            price: String,
        }

        let data: PriceResponse = response.json().await?;
        Ok(data.price.parse()?)
    }
}
