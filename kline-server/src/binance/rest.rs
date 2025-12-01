//! Binance Futures REST API - 获取合约历史K线数据

use anyhow::Result;
use crate::types::Kline;

/// Binance 合约 API 地址
const BINANCE_FUTURES_API: &str = "https://fapi.binance.com";

/// Binance REST API 客户端
pub struct BinanceRest {
    client: reqwest::Client,
}

impl BinanceRest {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    /// 获取历史K线数据
    ///
    /// # 参数
    /// - symbol: 交易对（如 BTCUSDT）
    /// - timeframe: 时间周期（如 1m, 5m, 1h）
    /// - limit: 返回数量（最大1000）
    /// - start_time: 起始时间（毫秒）
    /// - end_time: 结束时间（毫秒）
    pub async fn get_klines(
        &self,
        symbol: &str,
        timeframe: &str,
        limit: u32,
        start_time: Option<i64>,
        end_time: Option<i64>,
    ) -> Result<Vec<Kline>> {
        let mut url = format!(
            "{}/fapi/v1/klines?symbol={}&interval={}&limit={}",
            BINANCE_FUTURES_API,
            symbol.to_uppercase(),
            timeframe,
            limit.min(1000)
        );

        if let Some(st) = start_time {
            url.push_str(&format!("&startTime={}", st));
        }
        if let Some(et) = end_time {
            url.push_str(&format!("&endTime={}", et));
        }

        let response: Vec<Vec<serde_json::Value>> = self.client
            .get(&url)
            .send()
            .await?
            .json()
            .await?;

        let klines = response
            .into_iter()
            .map(|k| parse_kline_array(symbol, timeframe, &k))
            .collect::<Result<Vec<_>>>()?;

        Ok(klines)
    }

    /// 获取最新K线（用于补齐数据）
    pub async fn get_latest_klines(
        &self,
        symbol: &str,
        timeframe: &str,
        limit: u32,
    ) -> Result<Vec<Kline>> {
        self.get_klines(symbol, timeframe, limit, None, None).await
    }

    /// 批量获取历史 K 线数据（分批请求，支持超过 1000 条）
    ///
    /// Binance API 单次最多返回 1000 条，此函数自动分批请求
    ///
    /// # 参数
    /// - symbol: 交易对
    /// - timeframe: 时间周期
    /// - total_limit: 总共需要的数量（如 5000）
    /// - end_time: 结束时间（毫秒），从此时间往前获取
    pub async fn get_klines_batch(
        &self,
        symbol: &str,
        timeframe: &str,
        total_limit: usize,
        end_time: Option<i64>,
    ) -> Result<Vec<Kline>> {
        use tracing::info;

        let mut all_klines = Vec::with_capacity(total_limit);
        let mut current_end_time = end_time;
        let batch_size = 1000u32;

        info!(
            "Batch fetching {} klines for {}@{}",
            total_limit, symbol, timeframe
        );

        while all_klines.len() < total_limit {
            let remaining = total_limit - all_klines.len();
            let this_batch = (remaining as u32).min(batch_size);

            let batch = self
                .get_klines(symbol, timeframe, this_batch, None, current_end_time)
                .await?;

            if batch.is_empty() {
                info!("No more klines available, got {} total", all_klines.len());
                break;
            }

            // 更新下一次请求的结束时间（使用当前批次最早的开盘时间 - 1ms）
            if let Some(first) = batch.first() {
                current_end_time = Some(first.open_time * 1000 - 1);
            }

            let batch_len = batch.len();
            all_klines.extend(batch);

            info!(
                "Fetched batch of {} klines, total: {}",
                batch_len,
                all_klines.len()
            );

            // 避免请求过快，Binance 有频率限制
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }

        // 按时间正序排列
        all_klines.sort_by_key(|k| k.open_time);

        // 截取到目标数量
        if all_klines.len() > total_limit {
            // 保留最新的 total_limit 条
            let start = all_klines.len() - total_limit;
            all_klines = all_klines[start..].to_vec();
        }

        info!(
            "Batch fetch complete: {} klines for {}@{}",
            all_klines.len(),
            symbol,
            timeframe
        );

        Ok(all_klines)
    }
}

impl Default for BinanceRest {
    fn default() -> Self {
        Self::new()
    }
}

/// 解析 Binance K线数组格式
/// [
///   1499040000000,      // 0: 开盘时间（毫秒）
///   "0.01634000",       // 1: 开盘价
///   "0.80000000",       // 2: 最高价
///   "0.01575800",       // 3: 最低价
///   "0.01577100",       // 4: 收盘价
///   "148976.11427815",  // 5: 成交量
///   1499644799999,      // 6: 收盘时间（毫秒）
///   "2434.19055334",    // 7: 成交额
///   308,                // 8: 成交笔数
///   "1756.87402397",    // 9: 主动买入成交量
///   "28.46694368",      // 10: 主动买入成交额
///   "0"                 // 11: 忽略
/// ]
fn parse_kline_array(symbol: &str, timeframe: &str, arr: &[serde_json::Value]) -> Result<Kline> {
    if arr.len() < 11 {
        anyhow::bail!("Invalid kline array length: {}", arr.len());
    }

    let open_time_ms = arr[0].as_i64().ok_or_else(|| anyhow::anyhow!("Invalid open_time"))?;
    let close_time_ms = arr[6].as_i64().ok_or_else(|| anyhow::anyhow!("Invalid close_time"))?;

    Ok(Kline {
        symbol: symbol.to_uppercase(),
        timeframe: timeframe.to_string(),
        open_time: open_time_ms / 1000,  // 转换为秒
        open: parse_f64(&arr[1])?,
        high: parse_f64(&arr[2])?,
        low: parse_f64(&arr[3])?,
        close: parse_f64(&arr[4])?,
        volume: parse_f64(&arr[5])?,
        close_time: close_time_ms / 1000,  // 转换为秒
        quote_volume: parse_f64(&arr[7])?,
        trades: arr[8].as_i64().ok_or_else(|| anyhow::anyhow!("Invalid trades"))?,
        is_closed: true,  // 历史数据都是已收盘的
    })
}

fn parse_f64(v: &serde_json::Value) -> Result<f64> {
    match v {
        serde_json::Value::String(s) => s.parse().map_err(|e| anyhow::anyhow!("Parse error: {}", e)),
        serde_json::Value::Number(n) => n.as_f64().ok_or_else(|| anyhow::anyhow!("Invalid number")),
        _ => anyhow::bail!("Expected string or number, got: {:?}", v),
    }
}
