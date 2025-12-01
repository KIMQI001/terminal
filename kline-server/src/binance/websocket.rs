//! Binance WebSocket 连接器 - 实时K线数据订阅

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_socks::tcp::Socks5Stream;
use tracing::{debug, error, info, warn};

use crate::types::{Kline, SubscriptionKey};

/// Binance 合约 WebSocket 地址
const BINANCE_WS_BASE: &str = "wss://fstream.binance.com/ws";
const BINANCE_WS_HOST: &str = "fstream.binance.com";
const BINANCE_WS_PORT: u16 = 443;

/// Binance WebSocket 客户端
pub struct BinanceWs {
    subscriptions: Vec<SubscriptionKey>,
    kline_tx: mpsc::UnboundedSender<Kline>,
}

impl BinanceWs {
    pub fn new(kline_tx: mpsc::UnboundedSender<Kline>) -> Self {
        Self {
            subscriptions: Vec::new(),
            kline_tx,
        }
    }

    /// 添加订阅
    pub fn subscribe(&mut self, symbol: &str, timeframe: &str) {
        let key = SubscriptionKey::new(symbol, timeframe);
        if !self.subscriptions.contains(&key) {
            self.subscriptions.push(key);
        }
    }

    /// 构建 WebSocket URL
    fn build_ws_url(&self) -> String {
        if self.subscriptions.is_empty() {
            return BINANCE_WS_BASE.to_string();
        }

        let streams: Vec<String> = self
            .subscriptions
            .iter()
            .map(|s| format!("{}@kline_{}", s.symbol.to_lowercase(), s.timeframe))
            .collect();

        format!(
            "wss://fstream.binance.com/stream?streams={}",
            streams.join("/")
        )
    }

    /// 启动 WebSocket 连接
    pub async fn run(&self) -> Result<()> {
        if self.subscriptions.is_empty() {
            warn!("No subscriptions configured, WebSocket not started");
            return Ok(());
        }

        let url = self.build_ws_url();
        info!("Connecting to Binance WebSocket: {}", url);

        loop {
            match self.connect_and_listen(&url).await {
                Ok(_) => {
                    info!("WebSocket connection closed normally");
                    break;
                }
                Err(e) => {
                    error!("WebSocket error: {}, reconnecting in 5s...", e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                }
            }
        }

        Ok(())
    }

    async fn connect_and_listen(&self, url: &str) -> Result<()> {
        // 检查是否配置了代理
        let proxy_url = std::env::var("SOCKS5_PROXY").ok();

        if let Some(proxy) = &proxy_url {
            // 通过 SOCKS5 代理连接
            info!("Connecting via SOCKS5 proxy: {}", proxy);
            self.connect_via_proxy(url, proxy).await
        } else {
            // 直接连接
            info!("Connecting directly (no proxy)");
            self.connect_direct(url).await
        }
    }

    /// 直接连接（无代理）
    async fn connect_direct(&self, url: &str) -> Result<()> {
        let (ws_stream, _) = connect_async(url).await?;
        let (mut write, mut read) = ws_stream.split();

        info!("Connected to Binance WebSocket (direct)");
        self.handle_ws_stream(&mut write, &mut read).await
    }

    /// 通过 SOCKS5 代理连接
    async fn connect_via_proxy(&self, url: &str, proxy: &str) -> Result<()> {
        // 解析代理地址
        let proxy_addr = proxy.trim_start_matches("socks5://");

        // 通过 SOCKS5 代理建立 TCP 连接
        let socks_stream = Socks5Stream::connect(
            proxy_addr,
            (BINANCE_WS_HOST, BINANCE_WS_PORT),
        ).await?;

        // 获取底层 TCP 流
        let tcp_stream = socks_stream.into_inner();

        // 建立 TLS 连接
        let tls_connector = native_tls::TlsConnector::new()?;
        let tls_connector = tokio_native_tls::TlsConnector::from(tls_connector);
        let tls_stream = tls_connector.connect(BINANCE_WS_HOST, tcp_stream).await?;

        // 升级为 WebSocket
        let (ws_stream, _) = tokio_tungstenite::client_async(url, tls_stream).await?;
        let (mut write, mut read) = ws_stream.split();

        info!("Connected to Binance WebSocket (via proxy)");
        self.handle_ws_stream(&mut write, &mut read).await
    }

    /// 处理 WebSocket 消息流（通用逻辑）
    async fn handle_ws_stream<W, R>(&self, write: &mut W, read: &mut R) -> Result<()>
    where
        W: SinkExt<Message> + Unpin,
        R: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
        <W as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
    {
        // Ping 定时器
        let ping_interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
        tokio::pin!(ping_interval);

        loop {
            tokio::select! {
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Err(e) = self.handle_message(&text).await {
                                warn!("Failed to handle message: {}", e);
                            }
                        }
                        Some(Ok(Message::Ping(data))) => {
                            debug!("Received ping, sending pong");
                            write.send(Message::Pong(data)).await.map_err(|e| anyhow::anyhow!("{}", e))?;
                        }
                        Some(Ok(Message::Close(_))) => {
                            info!("Received close frame");
                            break;
                        }
                        Some(Err(e)) => {
                            error!("WebSocket error: {}", e);
                            return Err(e.into());
                        }
                        None => {
                            info!("WebSocket stream ended");
                            break;
                        }
                        _ => {}
                    }
                }
                _ = ping_interval.tick() => {
                    debug!("Sending ping");
                    write.send(Message::Ping(vec![])).await.map_err(|e| anyhow::anyhow!("{}", e))?;
                }
            }
        }

        Ok(())
    }

    async fn handle_message(&self, text: &str) -> Result<()> {
        // Binance 组合流格式: {"stream":"btcusdt@kline_1m","data":{...}}
        let msg: BinanceStreamMessage = serde_json::from_str(text)?;

        if let Some(kline_data) = msg.data.k {
            let kline = Kline {
                symbol: kline_data.s,
                timeframe: kline_data.i,
                open_time: kline_data.t / 1000,  // 毫秒转秒
                open: kline_data.o.parse()?,
                high: kline_data.h.parse()?,
                low: kline_data.l.parse()?,
                close: kline_data.c.parse()?,
                volume: kline_data.v.parse()?,
                close_time: kline_data.T / 1000,  // 毫秒转秒
                quote_volume: kline_data.q.parse()?,
                trades: kline_data.n,
                is_closed: kline_data.x,
            };

            self.kline_tx.send(kline)?;
        }

        Ok(())
    }
}

/// Binance 组合流消息格式
#[derive(serde::Deserialize)]
struct BinanceStreamMessage {
    #[allow(dead_code)]
    stream: String,
    data: BinanceKlineEvent,
}

/// Binance K线事件
#[derive(serde::Deserialize)]
#[allow(non_snake_case)]
struct BinanceKlineEvent {
    #[allow(dead_code)]
    e: String,  // 事件类型 "kline"
    #[allow(dead_code)]
    E: i64,     // 事件时间
    #[allow(dead_code)]
    s: String,  // 交易对
    k: Option<BinanceKlineData>,
}

/// Binance K线数据
#[derive(serde::Deserialize)]
#[allow(non_snake_case)]
struct BinanceKlineData {
    t: i64,      // K线开盘时间（毫秒）
    T: i64,      // K线收盘时间（毫秒）
    s: String,   // 交易对
    i: String,   // 时间周期
    #[allow(dead_code)]
    f: i64,      // 第一笔成交ID
    #[allow(dead_code)]
    L: i64,      // 最后一笔成交ID
    o: String,   // 开盘价
    c: String,   // 收盘价
    h: String,   // 最高价
    l: String,   // 最低价
    v: String,   // 成交量
    n: i64,      // 成交笔数
    x: bool,     // 是否收盘
    q: String,   // 成交额
    #[allow(dead_code)]
    V: String,   // 主动买入成交量
    #[allow(dead_code)]
    Q: String,   // 主动买入成交额
}
