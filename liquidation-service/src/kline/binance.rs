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

/// 聚合交易数据结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggTrade {
    pub price: f64,            // 成交价格
    pub quantity: f64,         // 成交数量
    pub quote_qty: f64,        // 成交额 (USDT)
    pub timestamp: i64,        // 时间戳
    pub is_buyer_maker: bool,  // true=卖单成交(做空开仓), false=买单成交(做多开仓)
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

    /// 获取聚合交易数据
    /// start_time, end_time: 毫秒时间戳
    /// limit: 最多 1000
    pub async fn get_agg_trades(
        &self,
        symbol: &str,
        start_time: Option<i64>,
        end_time: Option<i64>,
        limit: u32,
    ) -> Result<Vec<AggTrade>> {
        let mut url = format!(
            "{}/fapi/v1/aggTrades?symbol={}&limit={}",
            self.base_url, symbol, limit.min(1000)
        );

        if let Some(start) = start_time {
            url.push_str(&format!("&startTime={}", start));
        }
        if let Some(end) = end_time {
            url.push_str(&format!("&endTime={}", end));
        }

        let response = self.client.get(&url).send().await?;

        // 检查响应状态
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            anyhow::bail!("Binance API error: status={}, body={}", status, text);
        }

        // 先获取响应文本以便调试
        let text = response.text().await?;

        // 尝试解析为数组
        let data: Vec<AggTradeResponse> = serde_json::from_str(&text)
            .map_err(|e| anyhow::anyhow!("Failed to parse aggTrades response: {}, body: {}", e, &text[..text.len().min(200)]))?;

        let trades = data
            .into_iter()
            .map(|t| AggTrade {
                price: t.p.parse().unwrap_or(0.0),
                quantity: t.q.parse().unwrap_or(0.0),
                quote_qty: t.p.parse::<f64>().unwrap_or(0.0) * t.q.parse::<f64>().unwrap_or(0.0),
                timestamp: t.T,
                is_buyer_maker: t.m,
            })
            .collect();

        Ok(trades)
    }

    /// 批量获取一段时间内的所有聚合交易
    /// 由于单次请求最多 1000 条，需要分批获取
    pub async fn get_agg_trades_range(
        &self,
        symbol: &str,
        start_time: i64,
        end_time: i64,
    ) -> Result<Vec<AggTrade>> {
        let mut all_trades = Vec::new();
        let mut current_start = start_time;

        loop {
            let trades = self
                .get_agg_trades(symbol, Some(current_start), Some(end_time), 1000)
                .await?;

            if trades.is_empty() {
                break;
            }

            let last_time = trades.last().map(|t| t.timestamp).unwrap_or(end_time);
            all_trades.extend(trades);

            // 如果最后一条时间等于结束时间，或者返回的数据少于 1000 条，说明已获取完毕
            if last_time >= end_time || all_trades.len() % 1000 != 0 {
                break;
            }

            // 下一批从最后一条时间 +1 开始
            current_start = last_time + 1;

            // 避免请求过快
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }

        Ok(all_trades)
    }
}

/// Binance aggTrades API 响应结构
#[derive(Deserialize)]
struct AggTradeResponse {
    #[serde(rename = "p")]
    p: String,     // 价格
    #[serde(rename = "q")]
    q: String,     // 数量
    #[serde(rename = "T")]
    T: i64,        // 时间戳
    #[serde(rename = "m")]
    m: bool,       // 买方是否为做市商 (true=卖单成交, false=买单成交)
}
