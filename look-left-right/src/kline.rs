/**
 * K 线抓取:从 kline-server(Rust) 的只读 REST 缓存取
 *
 * GET {KLINE_API_URL}/api/klines/{SYMBOL}/{tf}?limit=N
 * → { symbol, timeframe, klines: [{ time, open, high, low, close, volume }] }
 *
 * time 是**秒级**时间戳,和前端 chartStore.candles 一致。
 */

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::types::Candle;

/// kline-server 地址
pub fn kline_api_url() -> String {
    std::env::var("KLINE_API_URL").unwrap_or_else(|_| "http://127.0.0.1:3001".to_string())
}

/// 前端 TradingChart 里的加载条数:BTCUSDC / ETHUSDC 拉 15000,其它 3000
pub fn default_limit(symbol: &str) -> usize {
    match symbol.to_uppercase().as_str() {
        "BTCUSDC" | "ETHUSDC" => 15000,
        _ => 3000,
    }
}

#[derive(Debug, Deserialize)]
struct KlineResp {
    #[serde(default)]
    klines: Vec<KlineCandle>,
}

#[derive(Debug, Deserialize)]
struct KlineCandle {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    #[serde(default)]
    volume: f64,
}

/// 拉取 K 线(kline-server 偶尔在回源时会返回 502,这里重试几次)
pub async fn fetch_klines(symbol: &str, timeframe: &str, limit: usize) -> Result<Vec<Candle>> {
    let url = format!(
        "{}/api/klines/{}/{}?limit={}",
        kline_api_url(),
        symbol.to_uppercase(),
        timeframe,
        limit
    );
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=3u32 {
        match fetch_klines_once(&url).await {
            Ok(candles) if !candles.is_empty() => return Ok(candles),
            Ok(_) => last_err = Some(anyhow::anyhow!("kline-server 返回空 K 线: {}", url)),
            Err(e) => last_err = Some(e),
        }
        if attempt < 3 {
            tokio::time::sleep(std::time::Duration::from_millis(800 * attempt as u64)).await;
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("拉取 K 线失败: {}", url)))
}

async fn fetch_klines_once(url: &str) -> Result<Vec<Candle>> {
    let t0 = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        // kline-server 在本机,必须绕过系统代理(macOS 系统代理会把 127.0.0.1 也劫走)
        .no_proxy()
        .build()
        .context("创建 HTTP 客户端失败")?;
    tracing::debug!("[Kline] 建 client 耗时 {:?}", t0.elapsed());
    let t1 = std::time::Instant::now();
    let resp = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("请求 kline-server 失败: {}", url))?;
    tracing::debug!("[Kline] 发请求耗时 {:?}", t1.elapsed());
    let t2 = std::time::Instant::now();
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("kline-server 返回 {}: {}", status, body);
    }
    let data: KlineResp = resp
        .json()
        .await
        .with_context(|| format!("解析 kline-server 响应失败: {}", url))?;
    tracing::debug!("[Kline] 解析+读取响应体耗时 {:?}", t2.elapsed());

    let candles: Vec<Candle> = data
        .klines
        .into_iter()
        .map(|k| Candle {
            time: k.time,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume,
        })
        .collect();
    Ok(candles)
}
