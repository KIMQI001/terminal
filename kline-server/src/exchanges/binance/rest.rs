//! Binance Futures REST API - 获取合约历史K线数据

use anyhow::Result;
use async_trait::async_trait;
use tracing::info;

use crate::exchanges::{ExchangeConfig, ExchangeRest};
use crate::types::ExchangeType;
use crate::types::Kline;

/// Binance REST API 客户端
pub struct BinanceRest {
    client: reqwest::Client,
    config: ExchangeConfig,
}

impl BinanceRest {
    pub fn new(config: ExchangeConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            config,
        }
    }
}

#[async_trait]
impl ExchangeRest for BinanceRest {
    fn exchange_type(&self) -> ExchangeType {
        ExchangeType::Binance
    }

    async fn get_klines(
        &self,
        symbol: &str,
        timeframe: &str,
        limit: u32,
        start_time: Option<i64>,
        end_time: Option<i64>,
    ) -> Result<Vec<Kline>> {
        let normalized_symbol = self.normalize_symbol(symbol);
        let normalized_tf = self.normalize_timeframe(timeframe);

        let mut url = format!(
            "{}/fapi/v1/klines?symbol={}&interval={}&limit={}",
            self.config.rest_url,
            normalized_symbol,
            normalized_tf,
            limit.min(self.max_klines_per_request())
        );

        if let Some(st) = start_time {
            url.push_str(&format!("&startTime={}", st));
        }
        if let Some(et) = end_time {
            url.push_str(&format!("&endTime={}", et));
        }

        let response: Vec<Vec<serde_json::Value>> =
            self.client.get(&url).send().await?.json().await?;

        let klines = response
            .into_iter()
            .map(|k| parse_kline_array(&normalized_symbol, &normalized_tf, &k))
            .collect::<Result<Vec<_>>>()?;

        Ok(klines)
    }

    async fn get_klines_batch(
        &self,
        symbol: &str,
        timeframe: &str,
        total_limit: usize,
        end_time: Option<i64>,
    ) -> Result<Vec<Kline>> {
        let mut all_klines = Vec::with_capacity(total_limit);
        let mut current_end_time = end_time;
        let batch_size = self.max_klines_per_request();

        info!(
            "[Binance] Batch fetching {} klines for {}@{}",
            total_limit, symbol, timeframe
        );

        while all_klines.len() < total_limit {
            let remaining = total_limit - all_klines.len();
            let this_batch = (remaining as u32).min(batch_size);

            let batch = self
                .get_klines(symbol, timeframe, this_batch, None, current_end_time)
                .await?;

            if batch.is_empty() {
                info!(
                    "[Binance] No more klines available, got {} total",
                    all_klines.len()
                );
                break;
            }

            // 更新下一次请求的结束时间（使用当前批次最早的开盘时间 - 1ms）
            if let Some(first) = batch.first() {
                current_end_time = Some(first.open_time * 1000 - 1);
            }

            let batch_len = batch.len();
            all_klines.extend(batch);

            info!(
                "[Binance] Fetched batch of {} klines, total: {}",
                batch_len,
                all_klines.len()
            );

            // 避免请求过快
            tokio::time::sleep(tokio::time::Duration::from_millis(self.config.rate_limit_ms))
                .await;
        }

        // 按时间正序排列
        all_klines.sort_by_key(|k| k.open_time);

        // 截取到目标数量
        if all_klines.len() > total_limit {
            let start = all_klines.len() - total_limit;
            all_klines = all_klines[start..].to_vec();
        }

        info!(
            "[Binance] Batch fetch complete: {} klines for {}@{}",
            all_klines.len(),
            symbol,
            timeframe
        );

        Ok(all_klines)
    }

    fn max_klines_per_request(&self) -> u32 {
        1000 // Binance 单次最大 1000 条
    }

    fn normalize_symbol(&self, symbol: &str) -> String {
        // Binance 使用大写无分隔符格式：BTCUSDC
        symbol.to_uppercase().replace("-", "").replace("/", "")
    }

    fn normalize_timeframe(&self, timeframe: &str) -> String {
        // Binance 时间周期格式：1m, 5m, 15m, 1h, 4h, 1d, 1w
        timeframe.to_lowercase()
    }
}

/// 解析 Binance K线数组格式
fn parse_kline_array(symbol: &str, timeframe: &str, arr: &[serde_json::Value]) -> Result<Kline> {
    if arr.len() < 11 {
        anyhow::bail!("Invalid kline array length: {}", arr.len());
    }

    let open_time_ms = arr[0]
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("Invalid open_time"))?;
    let close_time_ms = arr[6]
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("Invalid close_time"))?;

    Ok(Kline {
        symbol: symbol.to_uppercase(),
        timeframe: timeframe.to_string(),
        open_time: open_time_ms / 1000, // 毫秒转秒
        open: parse_f64(&arr[1])?,
        high: parse_f64(&arr[2])?,
        low: parse_f64(&arr[3])?,
        close: parse_f64(&arr[4])?,
        volume: parse_f64(&arr[5])?,
        close_time: close_time_ms / 1000, // 毫秒转秒
        quote_volume: parse_f64(&arr[7])?,
        trades: arr[8]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("Invalid trades"))?,
        is_closed: true, // 历史数据都是已收盘的
    })
}

fn parse_f64(v: &serde_json::Value) -> Result<f64> {
    match v {
        serde_json::Value::String(s) => {
            s.parse().map_err(|e| anyhow::anyhow!("Parse error: {}", e))
        }
        serde_json::Value::Number(n) => n
            .as_f64()
            .ok_or_else(|| anyhow::anyhow!("Invalid number")),
        _ => anyhow::bail!("Expected string or number, got: {:?}", v),
    }
}
