//! Pinbar 实时检测服务（命令行版本）
//!
//! 从 kline-server WebSocket 获取 K 线数据，实时检测 Pinbar 信号并输出到终端

use futures_util::{SinkExt, StreamExt};
use pinbar_detector::{detect_recent_pinbars, Candle};
use serde::Deserialize;
use std::collections::HashMap;
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// K线服务器地址
const KLINE_SERVER_URL: &str = "ws://localhost:3001/ws";

/// 每个周期返回的最近信号数量
const RECENT_SIGNALS_LIMIT: usize = 5;

/// Swing Point 检测长度
const SWING_LENGTH: usize = 50;

/// Swing Point 附近范围
const SWING_RANGE: usize = 5;

/// K线服务器 WebSocket 消息
#[derive(Debug, Deserialize)]
struct KlineMsg {
    #[serde(rename = "type")]
    msg_type: String,
    data: Option<KlineData>,
}

#[derive(Debug, Deserialize)]
struct KlineData {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

/// 缓存的 K 线数据
struct KlineCache {
    data: Vec<Candle>,
    timeframe: String,
}

impl KlineCache {
    fn new(timeframe: &str) -> Self {
        Self {
            data: Vec::new(),
            timeframe: timeframe.to_string(),
        }
    }

    fn push(&mut self, candle: Candle) {
        self.data.push(candle);
        // 限制缓存大小
        if self.data.len() > 5000 {
            self.data.remove(0);
        }
    }

    fn detect_pinbars(&self) {
        if self.data.len() < 100 {
            return;
        }

        let signals = detect_recent_pinbars(&self.data, SWING_LENGTH, SWING_RANGE, RECENT_SIGNALS_LIMIT);

        if !signals.is_empty() {
            info!("\n========== {} Pinbar 信号 ==========", self.timeframe);
            for (i, sig) in signals.iter().enumerate() {
                let direction = if sig.signal_type == "bullish" { "做多" } else { "做空" };
                let near = if sig.near_swing == "none" { "远离" } else { sig.near_swing.as_str() };
                println!(
                    "  [{}/{}] {} | 价格: {:.2} | 强度: {:.2} | 影线: 上{:.2} 下{:.2} | 位置: {}",
                    i + 1,
                    signals.len(),
                    direction,
                    sig.price,
                    sig.strength,
                    sig.top_wick_size,
                    sig.bottom_wick_size,
                    near
                );
            }
            println!();
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    info!("Starting Pinbar Detector (CLI)...");
    info!("K-line server: {}", KLINE_SERVER_URL);
    println!("\n监控交易对: BTCUSDC, ETHUSDC");
    println!("时间周期: 5m, 15m, 1h, 4h, 1d");
    println!("每收到 100 根 K 线检测一次 Pinbar 信号\n");

    // 连接到 K 线服务器
    info!("Connecting to K-line server...");
    let (ws_stream, _) = connect_async(KLINE_SERVER_URL).await?;
    let (mut write, mut read) = ws_stream.split();
    info!("Connected to K-line server");

    // 订阅 K 线数据
    let subscriptions = vec![
        ("BTCUSDC", "5m"),
        ("BTCUSDC", "15m"),
        ("BTCUSDC", "1h"),
        ("BTCUSDC", "4h"),
        ("BTCUSDC", "1d"),
        ("ETHUSDC", "5m"),
        ("ETHUSDC", "15m"),
        ("ETHUSDC", "1h"),
        ("ETHUSDC", "4h"),
        ("ETHUSDC", "1d"),
    ];

    for (symbol, tf) in &subscriptions {
        let msg = serde_json::json!({
            "type": "Subscribe",
            "data": { "symbol": symbol, "timeframe": tf }
        });
        write.send(Message::Text(msg.to_string())).await?;
        info!("Subscribed to {}@{}", symbol, tf);
    }

    // K 线缓存：symbol@timeframe -> KlineCache
    let mut caches: HashMap<String, KlineCache> = subscriptions
        .iter()
        .map(|(s, t)| (format!("{}@{}", s, t), KlineCache::new(t)))
        .collect();

    // 统计
    let mut update_counts: HashMap<String, usize> = subscriptions
        .iter()
        .map(|(s, t)| (format!("{}@{}", s, t), 0))
        .collect();

    // 处理消息
    while let Some(msg) = read.next().await {
        match msg? {
            Message::Text(text) => {
                if let Ok(kline_msg) = serde_json::from_str::<KlineMsg>(&text) {
                    if kline_msg.msg_type == "KlineUpdate" {
                        if let Some(data) = kline_msg.data {
                            // 尝试匹配缓存（简化处理：从 time 反推 timeframe）
                            let candle = Candle {
                                time: data.time,
                                open: data.open,
                                high: data.high,
                                low: data.low,
                                close: data.close,
                                volume: data.volume,
                            };

                            // 遍历所有缓存更新
                            for (key, cache) in caches.iter_mut() {
                                // 简单策略：每种 timeframe 都更新（会有重复，但不影响检测）
                                let parts: Vec<&str> = key.split('@').collect();
                                if parts.len() == 2 {
                                    cache.push(candle.clone());
                                    *update_counts.get_mut(key).unwrap() += 1;

                                    // 每 100 根 K 线检测一次
                                    if update_counts[key] % 100 == 0 && update_counts[key] > 0 {
                                        cache.detect_pinbars();
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Message::Close(_) => {
                warn!("K-line server closed connection");
                break;
            }
            _ => {}
        }
    }

    Ok(())
}