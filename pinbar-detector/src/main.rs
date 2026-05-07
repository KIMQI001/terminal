//! Pinbar 实时检测服务
//!
//! 从 kline-server WebSocket 获取 K 线数据，实时检测 Pinbar 信号并推送

use futures_util::{SinkExt, StreamExt};
use pinbar_detector::{detect_recent_pinbars, Candle, PinbarUpdate};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tracing::{info, warn, error};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// K线服务器地址
const KLINE_SERVER_URL: &str = "ws://localhost:3001/ws";

/// 前端推送地址
const FRONTEND_LISTEN_ADDR: &str = "0.0.0.0:3002";

/// 每个周期返回的最近信号数量
const RECENT_SIGNALS_LIMIT: usize = 5;

/// Swing Point 检测长度
const SWING_LENGTH: usize = 50;

/// Swing Point 附近范围
const SWING_RANGE: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubscribeData {
    symbol: String,
    timeframe: String,
}

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

/// 订阅状态
#[derive(Debug, Clone)]
struct Subscription {
    symbol: String,
    timeframe: String,
}

/// 客户端会话
struct ClientSession {
    subscriptions: Vec<Subscription>,
}

impl ClientSession {
    fn new() -> Self {
        Self {
            subscriptions: Vec::new(),
        }
    }

    fn subscribe(&mut self, symbol: &str, timeframe: &str) {
        if !self.subscriptions.iter().any(|s| s.symbol == symbol && s.timeframe == timeframe) {
            self.subscriptions.push(Subscription {
                symbol: symbol.to_uppercase(),
                timeframe: timeframe.to_string(),
            });
        }
    }

    fn unsubscribe(&mut self, symbol: &str, timeframe: &str) {
        self.subscriptions.retain(|s| !(s.symbol == symbol && s.timeframe == timeframe));
    }

    fn is_subscribed(&self, symbol: &str, timeframe: &str) -> bool {
        self.subscriptions.iter().any(|s| s.symbol == symbol && s.timeframe == timeframe)
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    info!("Starting Pinbar Detector Service...");
    info!("K-line server: {}", KLINE_SERVER_URL);
    info!("Frontend listen: {}", FRONTEND_LISTEN_ADDR);

    // 创建广播通道
    let (tx, rx) = broadcast::channel::<PinbarUpdate>(100);

    // 启动 K 线服务器连接任务
    let kline_tx = tx.clone();
    let kline_task = tokio::spawn(async move {
        if let Err(e) = connect_to_kline_server(kline_tx).await {
            error!("K-line server connection error: {}", e);
        }
    });

    // 启动前端 WebSocket 服务器
    let frontend_task = tokio::spawn(async move {
        if let Err(e) = start_frontend_server(rx).await {
            error!("Frontend server error: {}", e);
        }
    });

    // 等待任务
    tokio::select! {
        _ = kline_task => {},
        _ = frontend_task => {},
    }

    Ok(())
}

/// 连接到 K 线服务器
async fn connect_to_kline_server(tx: broadcast::Sender<PinbarUpdate>) -> anyhow::Result<()> {
    info!("Connecting to K-line server...");

    let (ws_stream, _) = tokio_tungstenite::connect_async(KLINE_SERVER_URL).await?;
    let (mut write, mut read) = ws_stream.split();

    info!("Connected to K-line server");

    // 订阅所有需要的 K 线数据
    let symbols = vec!["BTCUSDC", "ETHUSDC"];
    let timeframes = vec!["5m", "15m", "1h", "4h", "1d"];

    for symbol in &symbols {
        for tf in &timeframes {
            let msg = serde_json::json!({
                "type": "Subscribe",
                "data": {
                    "symbol": symbol,
                    "timeframe": tf
                }
            });
            write.send(Message::Text(msg.to_string())).await?;
            info!("Subscribed to {}@{}", symbol, tf);
        }
    }

    // 缓存 K 线数据
    let mut kline_cache: std::collections::HashMap<String, Vec<Candle>> = std::collections::HashMap::new();

    // 处理消息
    while let Some(msg) = read.next().await {
        match msg? {
            Message::Text(text) => {
                if let Ok(kline_msg) = serde_json::from_str::<KlineMsg>(&text) {
                    if kline_msg.msg_type == "KlineUpdate" {
                        if let Some(data) = kline_msg.data {
                            let _candle = Candle {
                                time: data.time,
                                open: data.open,
                                high: data.high,
                                low: data.low,
                                close: data.close,
                                volume: data.volume,
                            };

                            // 更新缓存 - TODO: 需要从消息中提取 symbol 和 timeframe
                            let key = "BTCUSDC@1h".to_string();
                            let cache = kline_cache.entry(key.clone()).or_insert_with(Vec::new);
                            cache.push(_candle);

                            // 限制缓存大小
                            if cache.len() > 5000 {
                                *cache = cache.split_off(cache.len() - 5000);
                            }

                            // 检测 Pinbar（简化处理：每100根K线检测一次）
                            if cache.len() % 100 == 0 {
                                let signals = detect_recent_pinbars(cache, SWING_LENGTH, SWING_RANGE, RECENT_SIGNALS_LIMIT);
                                let update = PinbarUpdate {
                                    symbol: "BTCUSDC".to_string(),
                                    timeframe: "1h".to_string(),
                                    signals,
                                    swing_points: vec![],
                                };
                                let _ = tx.send(update);
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

/// 启动前端 WebSocket 服务器
async fn start_frontend_server(rx: broadcast::Receiver<PinbarUpdate>) -> anyhow::Result<()> {
    let addr = FRONTEND_LISTEN_ADDR;
    let listener = TcpListener::bind(addr).await?;
    info!("Frontend WebSocket server listening on {}", addr);

    loop {
        match listener.accept().await {
            Ok((stream, peer_addr)) => {
                info!("Client connected: {}", peer_addr);
                let rx = rx.resubscribe();
                tokio::spawn(handle_frontend_client(stream, rx));
            }
            Err(e) => {
                error!("Failed to accept connection: {}", e);
            }
        }
    }
}

/// 处理前端客户端
async fn handle_frontend_client(stream: tokio::net::TcpStream, mut rx: broadcast::Receiver<PinbarUpdate>) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            error!("WebSocket handshake error: {}", e);
            return;
        }
    };

    let (mut write, mut read) = ws_stream.split();
    let mut session = ClientSession::new();

    loop {
        tokio::select! {
            // 发送 Pinbar 更新
            update = rx.recv() => {
                match update {
                    Ok(update) => {
                        if session.is_subscribed(&update.symbol, &update.timeframe) {
                            let msg = WsMessage {
                                msg_type: "PinbarUpdate".to_string(),
                                data: Some(serde_json::to_value(&update).unwrap()),
                            };
                            if let Ok(json) = serde_json::to_string(&msg) {
                                if write.send(Message::Text(json)).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                    Err(_) => return,
                }
            }
            // 处理客户端消息
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                            match ws_msg.msg_type.as_str() {
                                "Subscribe" => {
                                    if let Some(data) = ws_msg.data {
                                        if let Ok(sub) = serde_json::from_value::<SubscribeData>(data) {
                                            session.subscribe(&sub.symbol, &sub.timeframe);
                                            info!("Client subscribed to {}@{}", sub.symbol, sub.timeframe);
                                        }
                                    }
                                }
                                "Unsubscribe" => {
                                    if let Some(data) = ws_msg.data {
                                        if let Ok(sub) = serde_json::from_value::<SubscribeData>(data) {
                                            session.unsubscribe(&sub.symbol, &sub.timeframe);
                                            info!("Client unsubscribed from {}@{}", sub.symbol, sub.timeframe);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        info!("Client disconnected");
                        return;
                    }
                    _ => {}
                }
            }
        }
    }
}