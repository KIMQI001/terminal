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
///
/// **K close 判定**:**用启发式,不只依赖 `k.x` 字段**。
///
/// Binance `continuousKline` 通道在 K 切换的瞬间**偶尔漏推 `k.x=true` 的事件** —
/// 实测 15m 周期下,经常出现 `x` 永远停在 `false`,但 K 线本身已经 close 的情况。
///
/// 对齐前端 `src/lib/binance/websocket.ts:154-179` 的做法:维护 `last_kline_time`,
/// 当推送的 `k.t` 比上一条大时(说明进入新 K),就认为**上一根 K 已经 close** ——
/// 此时拿到的 candle 数据就是上一根 K close 时的完整 OHLC。
///
/// 触发检测的条件 = `k.x == true` OR `(last_kline_time != 0 && k.t > last_kline_time)`
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

        // 启发式:记录上一条推送的 K 开盘时间
        let mut last_kline_time: i64 = 0;

        while let Some(msg) = ws.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    debug!("ws msg: {} bytes", text.len());
                    match serde_json::from_str::<WsKlineMsg>(&text) {
                        Ok(parsed) => {
                            if let Some(k) = parsed.k {
                                let k_time = k.t / 1000;
                                // 启发式:K 开盘时间比上一条大 → 上一根 K close 了
                                let is_new_kline = last_kline_time != 0 && k_time > last_kline_time;
                                // 触发检测:显式 x=true OR 启发式新 K
                                let should_detect = k.x || is_new_kline;
                                debug!(
                                    "kline: t={} T={} O={} H={} L={} C={} V={} x={} is_new={} should_detect={}",
                                    k.t, k.close_t, k.o, k.h, k.l, k.c, k.v, k.x, is_new_kline, should_detect
                                );
                                if should_detect {
                                    // 收线瞬间打 info,确保默认 info 级别也能看到
                                    info!(
                                        "[K close detected] t={} x={} is_new={} → triggering detection",
                                        k.t, k.x, is_new_kline
                                    );
                                }
                                last_kline_time = k_time;
                                on_candle(Candle {
                                    time: k_time,
                                    open: k.o.parse().unwrap_or(0.0),
                                    high: k.h.parse().unwrap_or(0.0),
                                    low: k.l.parse().unwrap_or(0.0),
                                    close: k.c.parse().unwrap_or(0.0),
                                    volume: k.v.parse().unwrap_or(0.0),
                                }, should_detect);
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
    /// K-line 开盘时间(ms)
    #[serde(rename = "t")]
    t: i64,
    /// K-line close 时间(ms)— 用于兜底判断 K 是否已 close
    #[serde(rename = "T")]
    close_t: i64,
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
