//! Binance API + WebSocket(简化版,只拉单一交易对 K 线)

use crate::types::Candle;
use anyhow::{Context, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use std::env;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info, warn};

#[derive(Clone)]
pub struct BinanceConfig {
    pub symbol: String,
    pub timeframe: String,
    // API 凭据走 env 直读(order 模块),此处留字段以便其他场景(如签名请求)
    #[allow(dead_code)]
    pub api_key: Option<String>,
    #[allow(dead_code)]
    pub api_secret: Option<String>,
}

impl BinanceConfig {
    pub fn from_env() -> Result<Self> {
        let _ = dotenvy::dotenv();
        Ok(Self {
            symbol: env::var("SYMBOL").unwrap_or_else(|_| "BTCUSDC".to_string()),
            timeframe: env::var("TIMEFRAME").unwrap_or_else(|_| "15m".to_string()),
            api_key: env::var("BINANCE_API_KEY").ok().filter(|s| !s.is_empty()),
            api_secret: env::var("BINANCE_API_SECRET").ok().filter(|s| !s.is_empty()),
        })
    }

    fn base_url(&self) -> &'static str {
        "https://fapi.binance.com"
    }

    fn ws_url(&self) -> String {
        // USDC 永续合约在 /market/ 子路径,频道 2024-11 起统一为
        // {symbol}_perpetual@continuousKline_{tf}(@kline_{tf} 已失效)
        format!(
            "wss://fstream.binance.com/market/ws/{}_perpetual@continuousKline_{}",
            self.symbol.to_lowercase(),
            self.timeframe
        )
    }
}

/// 拉历史 K 线(REST)
pub async fn fetch_klines(
    config: &BinanceConfig,
    limit: usize,
) -> Result<Vec<Candle>> {
    let url = format!(
        "{}/fapi/v1/klines?symbol={}&interval={}&limit={}",
        config.base_url(),
        config.symbol,
        config.timeframe,
        limit
    );
    let client = Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .context("fetch klines http")?
        .error_for_status()
        .context("fetch klines status")?;
    let data: Vec<Vec<serde_json::Value>> = resp.json().await.context("parse klines")?;

    let candles = data
        .iter()
        .filter_map(|row| {
            if row.len() < 6 {
                return None;
            }
            let time_ms = row[0].as_i64()?;
            let open = row[1].as_str()?.parse().ok()?;
            let high = row[2].as_str()?.parse().ok()?;
            let low = row[3].as_str()?.parse().ok()?;
            let close = row[4].as_str()?.parse().ok()?;
            let volume = row[5].as_str()?.parse().ok()?;
            Some(Candle {
                time: time_ms / 1000,
                open,
                high,
                low,
                close,
                volume,
            })
        })
        .collect();
    Ok(candles)
}

/// 实时 WS 接收单一 K 线更新
/// 回调 `is_closed` 为 true 表示这根 K 已收盘(才进行 wick 检测)
pub async fn stream_klines<F, Fut>(config: &BinanceConfig, mut on_candle: F) -> Result<()>
where
    F: FnMut(Candle, bool) -> Fut,
    Fut: std::future::Future<Output = ()> + Send,
{
    let url = config.ws_url();
    info!("connecting to {}", url);

    loop {
        let (mut ws, _) = match connect_async(&url).await {
            Ok(v) => v,
            Err(e) => {
                error!("ws connect error: {e}; retrying in 5s");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };
        info!("ws connected");

        while let Some(msg) = ws.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    debug!("ws msg: {} bytes", text.len());
                    match serde_json::from_str::<WsKlineMsg>(&text) {
                        Ok(parsed) => {
                            if let Some(k) = parsed.k {
                                debug!("kline: t={} O={} H={} L={} C={} V={} x={}", k.t, k.o, k.h, k.l, k.c, k.v, k.x);
                                on_candle(Candle {
                                    time: k.t / 1000,
                                    open: k.o.parse().unwrap_or(0.0),
                                    high: k.h.parse().unwrap_or(0.0),
                                    low: k.l.parse().unwrap_or(0.0),
                                    close: k.c.parse().unwrap_or(0.0),
                                    volume: k.v.parse().unwrap_or(0.0),
                                }, k.x);
                            }
                        }
                        Err(e) => {
                            warn!("ws parse error: {} (text head: {})", e, &text[..text.len().min(120)]);
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    warn!("ws closed; reconnecting");
                    break;
                }
                Err(e) => {
                    error!("ws error: {e}; reconnecting");
                    break;
                }
                _ => {}
            }
        }

        let _ = ws.close(None).await;
        info!("ws disconnected; reconnecting in 5s");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

#[derive(Debug, Deserialize)]
struct WsKlineMsg {
    #[serde(rename = "k")]
    k: Option<WsKline>,
}

#[derive(Debug, Deserialize)]
struct WsKline {
    #[serde(rename = "t")]
    t: i64,
    #[serde(rename = "o")]
    o: String,
    #[serde(rename = "h")]
    h: String,
    #[serde(rename = "l")]
    l: String,
    #[serde(rename = "c")]
    c: String,
    #[serde(rename = "v")]
    v: String,
    #[serde(rename = "x")]
    #[serde(default)]
    x: bool,
}

#[allow(dead_code)]
impl WsKline {
    fn is_closed(&self) -> bool { self.x }
}
