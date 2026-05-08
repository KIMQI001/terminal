//! Pinbar 实时检测服务（命令行版本）
//!
//! 1. 先通过 REST API 获取历史 K 线数据
//! 2. WebSocket 实时更新 K 线
//! 3. 实时检测 Pinbar 信号并输出到终端

use futures_util::{SinkExt, StreamExt};
use pinbar_detector::{detect_recent_pinbars, Candle};
use serde::Deserialize;
use std::collections::HashMap;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// K线服务器地址
const KLINE_SERVER_URL: &str = "ws://localhost:3001/ws";

/// REST API 地址
const REST_API_URL: &str = "http://localhost:3001/api/klines";

/// 每个周期返回的最近信号数量
const RECENT_SIGNALS_LIMIT: usize = 5;

/// Swing Point 检测长度
const SWING_LENGTH: usize = 50;

/// Swing Point 附近范围
const SWING_RANGE: usize = 5;

/// K线数据
#[derive(Debug, Deserialize)]
struct KlineData {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

/// REST API 响应
#[derive(Debug, Deserialize)]
struct KlineResponse {
    #[allow(dead_code)]
    symbol: String,
    #[allow(dead_code)]
    timeframe: String,
    klines: Vec<KlineData>,
}

/// WebSocket 消息
#[derive(Debug, Deserialize)]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    data: Option<KlineData>,
}

/// 缓存的 K 线数据
struct KlineCache {
    candles: Vec<Candle>,
    timeframe: String,
    update_count: usize,
}

impl KlineCache {
    fn new(timeframe: &str) -> Self {
        Self {
            candles: Vec::new(),
            timeframe: timeframe.to_string(),
            update_count: 0,
        }
    }

    fn load_from_api(&mut self, data: Vec<KlineData>) {
        self.candles = data
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
        info!("Loaded {} candles for {}", self.candles.len(), self.timeframe);
    }

    fn push(&mut self, candle: Candle) {
        // 检查是否是新股或者更新最后一根
        if let Some(last) = self.candles.last() {
            if last.time == candle.time {
                // 更新最后一根
                self.candles.pop();
                self.candles.push(candle);
                return;
            }
        }
        self.candles.push(candle);
        // 限制缓存大小
        if self.candles.len() > 5000 {
            self.candles.remove(0);
        }
        self.update_count += 1;
    }

    fn detect_and_print(&self, symbol: &str) {
        if self.candles.len() < 50 {
            return;
        }

        let signals = detect_recent_pinbars(
            &self.candles,
            SWING_LENGTH,
            SWING_RANGE,
            RECENT_SIGNALS_LIMIT,
        );

        if !signals.is_empty() {
            println!();
            println!("┌─────────────────────────────────────────────────────────────────────────────┐");
            println!("│                      {} {} PINBAR 信号检测                                  │", symbol, self.timeframe);
            println!("├─────┬────────┬───────────┬────────┬────────┬────────┬────────┬────────────┤");
            println!("│ #   │ 类型    │ 时间(UTC+8)│ 价格   │ 强度   │ 实体   │ 上影   │ 下影   │ 位置    │ 评估       │");
            println!("├─────┼────────┼───────────┼────────┼────────┼────────┼────────┼────────┼────────────┤");

            for (i, sig) in signals.iter().enumerate() {
                let direction = if sig.signal_type == "bullish" { "🐂做多" } else { "🐻做空" };
                let near = match sig.near_swing.as_str() {
                    "low" => "Swing Low",
                    "high" => "Swing High",
                    _ => "远离结构",
                };

                // UTC+8 时间
                let dt = chrono::DateTime::from_timestamp(sig.time, 0)
                    .map(|dt| {
                        let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
                        dt.with_timezone(&offset)
                    })
                    .map(|d| d.format("%m-%d %H:%M").to_string())
                    .unwrap_or_else(|| sig.time.to_string());

                let quality = if sig.strength > 0.7 && sig.near_swing != "none" {
                    "⭐⭐⭐优质"
                } else if sig.strength > 0.5 {
                    "⭐⭐良好"
                } else {
                    "⭐一般"
                };

                println!(
                    "│ {:3} │ {:6} │ {} │ {:7.2} │ {:5.0}% │ {:6.2} │ {:6.2} │ {:6.2} │ {:10} │ {} │",
                    i + 1,
                    direction,
                    dt,
                    sig.price,
                    sig.strength * 100.0,
                    sig.body_size,
                    sig.top_wick_size,
                    sig.bottom_wick_size,
                    near,
                    quality
                );
            }

            println!("└─────────────────────────────────────────────────────────────────────────────┘");
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

    println!("\n==========================================");
    println!("         Pinbar 实时检测服务 (CLI)");
    println!("==========================================\n");

    let subscriptions = vec![
        ("BTCUSDC", "15m"),
    ];

    // 初始化缓存
    let mut caches: HashMap<String, KlineCache> = subscriptions
        .iter()
        .map(|(s, t)| {
            let key = format!("{}@{}", s, t);
            (key, KlineCache::new(t))
        })
        .collect();

    // 1. 先通过 REST API 获取历史 K 线数据
    info!("Fetching historical klines via REST API...");

    for (symbol, tf) in &subscriptions {
        let key = format!("{}@{}", symbol, tf);
        let url = format!("{}/{}/{}?limit=1000", REST_API_URL, symbol, tf);

        match reqwest::get(&url).await {
            Ok(resp) => {
                if let Ok(data) = resp.json::<KlineResponse>().await {
                    if let Some(cache) = caches.get_mut(&key) {
                        cache.load_from_api(data.klines);
                        // 加载后立即检测一次
                        cache.detect_and_print(symbol);
                    }
                }
            }
            Err(e) => {
                warn!("Failed to fetch {}: {}", key, e);
            }
        }
    }

    println!("\n历史数据加载完成，开始监听实时 K 线...\n");

    // 2. 连接到 WebSocket 实时更新
    info!("Connecting to WebSocket for real-time updates...");
    let (ws_stream, _) = connect_async(KLINE_SERVER_URL).await?;
    let (mut write, mut read) = ws_stream.split();
    info!("Connected to K-line server");

    // 订阅实时 K 线
    for (symbol, tf) in &subscriptions {
        let msg = serde_json::json!({
            "type": "Subscribe",
            "data": { "symbol": symbol, "timeframe": tf }
        });
        write.send(Message::Text(msg.to_string())).await?;
    }
    info!("Subscribed to all timeframes");

    // 3. 处理实时 K 线
    while let Some(msg) = read.next().await {
        match msg? {
            Message::Text(text) => {
                if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                    if ws_msg.msg_type == "KlineUpdate" {
                        if let Some(data) = ws_msg.data {
                            let candle = Candle {
                                time: data.time,
                                open: data.open,
                                high: data.high,
                                low: data.low,
                                close: data.close,
                                volume: data.volume,
                            };

                            // 更新所有匹配的缓存（简化处理：更新所有）
                            for (key, cache) in caches.iter_mut() {
                                cache.push(candle.clone());

                                // 每 10 根 K 线检测一次
                                if cache.update_count > 0 && cache.update_count % 10 == 0 {
                                    let parts: Vec<&str> = key.split('@').collect();
                                    if parts.len() == 2 {
                                        cache.detect_and_print(parts[0]);
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