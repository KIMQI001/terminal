use anyhow::Result;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_socks::tcp::Socks5Stream;
use tokio_tungstenite::tungstenite::{handshake::client::Request, Message};
use url::Url;

use crate::kline::BinanceKlineClient;
use crate::storage::{AggTradeRecord, ForceOrder, Storage};

/// Binance 爆仓订单数据结构
#[derive(Debug, Deserialize)]
struct ForceOrderEvent {
    #[serde(rename = "e")]
    event_type: String,
    #[serde(rename = "E")]
    event_time: i64,
    #[serde(rename = "o")]
    order: ForceOrderData,
}

#[derive(Debug, Deserialize)]
struct ForceOrderData {
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "S")]
    side: String, // BUY = 空头被清算, SELL = 多头被清算
    #[serde(rename = "o")]
    order_type: String,
    #[serde(rename = "f")]
    time_in_force: String,
    #[serde(rename = "q")]
    quantity: String,
    #[serde(rename = "p")]
    price: String,
    #[serde(rename = "ap")]
    average_price: String,
    #[serde(rename = "X")]
    status: String,
    #[serde(rename = "l")]
    last_filled_qty: String,
    #[serde(rename = "z")]
    filled_qty: String,
    #[serde(rename = "T")]
    trade_time: i64,
}

/// 爆仓数据收集器
pub struct ForceOrderCollector {
    ws_url: String,
    kline_client: Arc<BinanceKlineClient>,
    storage: Arc<Storage>,
    symbols: Vec<String>,
}

impl ForceOrderCollector {
    pub fn new(
        ws_url: &str,
        kline_client: Arc<BinanceKlineClient>,
        storage: Arc<Storage>,
        symbols: Vec<String>,
    ) -> Self {
        Self {
            ws_url: ws_url.to_string(),
            kline_client,
            storage,
            symbols,
        }
    }

    /// 启动收集器（异步任务）
    pub async fn start(self: Arc<Self>) -> Result<()> {
        let url = format!("{}/ws/!forceOrder@arr", self.ws_url);
        tracing::info!("Connecting to Binance forceOrder stream: {}", url);

        loop {
            match self.run_connection(&url).await {
                Ok(_) => {
                    tracing::warn!("WebSocket connection closed, reconnecting in 5 seconds...");
                }
                Err(e) => {
                    tracing::error!("WebSocket error: {}, reconnecting in 5 seconds...", e);
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    }

    async fn run_connection(&self, url: &str) -> Result<()> {
        let parsed_url = Url::parse(url)?;
        let host = parsed_url.host_str().ok_or_else(|| anyhow::anyhow!("No host in URL"))?;
        let port = parsed_url.port().unwrap_or(443);

        // 检查是否有 SOCKS5 代理
        let proxy_addr = std::env::var("SOCKS5_PROXY").ok();

        // 生成 WebSocket key
        let key = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            rand::random::<[u8; 16]>(),
        );

        let ws_stream = if let Some(proxy) = &proxy_addr {
            tracing::info!("Connecting via SOCKS5 proxy: {}", proxy);

            // 通过 SOCKS5 代理连接
            let target_addr = format!("{}:{}", host, port);
            let stream = Socks5Stream::connect(proxy.as_str(), target_addr.as_str())
                .await
                .map_err(|e| anyhow::anyhow!("SOCKS5 connection failed: {}", e))?;

            let tcp_stream = stream.into_inner();

            // 创建 TLS 连接器
            let connector = native_tls::TlsConnector::new()?;
            let connector = tokio_native_tls::TlsConnector::from(connector);
            let tls_stream = connector.connect(host, tcp_stream).await?;

            // WebSocket 握手（使用正确的 WebSocket 头）
            let request = Request::builder()
                .uri(url)
                .header("Host", host)
                .header("Upgrade", "websocket")
                .header("Connection", "Upgrade")
                .header("Sec-WebSocket-Key", &key)
                .header("Sec-WebSocket-Version", "13")
                .body(())?;

            let (ws, _) = tokio_tungstenite::client_async(request, tls_stream).await?;
            ws
        } else {
            tracing::info!("Connecting directly (no proxy)");

            // 直接连接
            let tcp_stream = TcpStream::connect(format!("{}:{}", host, port)).await?;

            // 创建 TLS 连接器
            let connector = native_tls::TlsConnector::new()?;
            let connector = tokio_native_tls::TlsConnector::from(connector);
            let tls_stream = connector.connect(host, tcp_stream).await?;

            // WebSocket 握手
            let request = Request::builder()
                .uri(url)
                .header("Host", host)
                .header("Upgrade", "websocket")
                .header("Connection", "Upgrade")
                .header("Sec-WebSocket-Key", &key)
                .header("Sec-WebSocket-Version", "13")
                .body(())?;

            let (ws, _) = tokio_tungstenite::client_async(request, tls_stream).await?;
            ws
        };

        let (mut write, mut read) = ws_stream.split();

        tracing::info!("Connected to Binance forceOrder stream");

        // 心跳任务
        let heartbeat_handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                if write.send(Message::Pong(vec![])).await.is_err() {
                    break;
                }
            }
        });

        // 处理消息
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Err(e) = self.handle_message(&text).await {
                        tracing::error!("Failed to handle message: {}", e);
                    }
                }
                Ok(Message::Ping(data)) => {
                    tracing::debug!("Received ping");
                    // Pong 由 heartbeat 处理
                    let _ = data;
                }
                Ok(Message::Close(_)) => {
                    tracing::warn!("WebSocket closed by server");
                    break;
                }
                Err(e) => {
                    tracing::error!("WebSocket error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        heartbeat_handle.abort();
        Ok(())
    }

    async fn handle_message(&self, text: &str) -> Result<()> {
        // 解析爆仓事件（可能是单个或数组）
        let events: Vec<ForceOrderEvent> = if text.starts_with('[') {
            serde_json::from_str(text)?
        } else {
            vec![serde_json::from_str(text)?]
        };

        for event in events {
            // 只处理我们关心的交易对
            if !self.symbols.contains(&event.order.symbol) && !self.symbols.is_empty() {
                continue;
            }

            // 获取当前市价
            let market_price = match self.kline_client.get_price(&event.order.symbol).await {
                Ok(price) => price,
                Err(e) => {
                    tracing::warn!("Failed to get market price for {}: {}", event.order.symbol, e);
                    continue;
                }
            };

            let liq_price: f64 = event.order.average_price.parse().unwrap_or(0.0);
            let quantity: f64 = event.order.filled_qty.parse().unwrap_or(0.0);

            if liq_price <= 0.0 || quantity <= 0.0 {
                continue;
            }

            // 反推杠杆
            let is_long = event.order.side == "SELL"; // SELL = 多头被清算
            let estimated_leverage = self.estimate_leverage(market_price, liq_price, is_long);

            let quote_qty = liq_price * quantity;

            let force_order = ForceOrder {
                symbol: event.order.symbol.clone(),
                side: event.order.side.clone(),
                price: liq_price,
                quantity,
                quote_qty,
                market_price,
                estimated_leverage,
                timestamp: event.order.trade_time,
            };

            tracing::info!(
                "ForceOrder: {} {} @ {} (market: {}) | est_lev: {}x | qty: {:.2} USDT",
                force_order.symbol,
                force_order.side,
                force_order.price,
                force_order.market_price,
                force_order.estimated_leverage,
                force_order.quote_qty
            );

            // 保存到数据库
            if let Err(e) = self.storage.save_force_order(&force_order) {
                tracing::error!("Failed to save force order: {}", e);
            }
        }

        Ok(())
    }

    /// 反推杠杆倍数
    fn estimate_leverage(&self, market_price: f64, liq_price: f64, is_long: bool) -> u32 {
        // 清算价与市价的差距比例
        let diff_ratio = if is_long {
            // 多头：清算价 < 市价
            (market_price - liq_price) / market_price
        } else {
            // 空头：清算价 > 市价
            (liq_price - market_price) / market_price
        };

        if diff_ratio <= 0.0 {
            return 1;
        }

        // 杠杆 ≈ 1 / diff_ratio
        // 但要考虑维持保证金率 (约 0.4%)
        let estimated = (1.0 / (diff_ratio + 0.004)).round() as u32;

        // 四舍五入到标准杠杆值
        self.round_to_standard_leverage(estimated)
    }

    fn round_to_standard_leverage(&self, leverage: u32) -> u32 {
        // Binance 常用杠杆倍数
        const STANDARD_LEVERAGES: [u32; 10] = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100];

        STANDARD_LEVERAGES
            .iter()
            .min_by_key(|&&l| (l as i32 - leverage as i32).abs())
            .copied()
            .unwrap_or(leverage.clamp(1, 125))
    }
}

/// 启动收集器的便捷函数
pub fn spawn_collector(
    ws_url: &str,
    kline_client: Arc<BinanceKlineClient>,
    storage: Arc<Storage>,
    symbols: Vec<String>,
) -> tokio::task::JoinHandle<()> {
    let collector = Arc::new(ForceOrderCollector::new(ws_url, kline_client, storage, symbols));

    tokio::spawn(async move {
        if let Err(e) = collector.start().await {
            tracing::error!("Collector stopped with error: {}", e);
        }
    })
}

// ============ AggTrades 收集器 ============

/// Binance aggTrade 数据结构
#[derive(Debug, Deserialize)]
struct AggTradeEvent {
    #[serde(rename = "e")]
    event_type: String,
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "p")]
    price: String,
    #[serde(rename = "q")]
    quantity: String,
    #[serde(rename = "T")]
    trade_time: i64,
    #[serde(rename = "m")]
    is_buyer_maker: bool,
}

/// AggTrades 收集器
pub struct AggTradesCollector {
    ws_url: String,
    storage: Arc<Storage>,
    symbols: Vec<String>,
}

impl AggTradesCollector {
    pub fn new(ws_url: &str, storage: Arc<Storage>, symbols: Vec<String>) -> Self {
        Self {
            ws_url: ws_url.to_string(),
            storage,
            symbols,
        }
    }

    /// 启动收集器
    pub async fn start(self: Arc<Self>) -> Result<()> {
        // 订阅多个交易对的 aggTrade 流
        // 格式: /stream?streams=btcusdt@aggTrade/ethusdt@aggTrade
        let streams: Vec<String> = self
            .symbols
            .iter()
            .map(|s| format!("{}@aggTrade", s.to_lowercase()))
            .collect();
        let stream_param = streams.join("/");
        let url = format!("{}/stream?streams={}", self.ws_url, stream_param);

        tracing::info!("Connecting to Binance aggTrade stream: {}", url);

        loop {
            match self.run_connection(&url).await {
                Ok(_) => {
                    tracing::warn!("AggTrades WebSocket closed, reconnecting in 5 seconds...");
                }
                Err(e) => {
                    tracing::error!("AggTrades WebSocket error: {}, reconnecting in 5 seconds...", e);
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    }

    async fn run_connection(&self, url: &str) -> Result<()> {
        let parsed_url = Url::parse(url)?;
        let host = parsed_url.host_str().ok_or_else(|| anyhow::anyhow!("No host"))?;
        let port = parsed_url.port().unwrap_or(443);

        let proxy_addr = std::env::var("SOCKS5_PROXY").ok();

        let key = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            rand::random::<[u8; 16]>(),
        );

        let ws_stream = if let Some(proxy) = &proxy_addr {
            tracing::info!("AggTrades connecting via SOCKS5 proxy: {}", proxy);

            let target_addr = format!("{}:{}", host, port);
            let stream = Socks5Stream::connect(proxy.as_str(), target_addr.as_str())
                .await
                .map_err(|e| anyhow::anyhow!("SOCKS5 failed: {}", e))?;

            let tcp_stream = stream.into_inner();
            let connector = native_tls::TlsConnector::new()?;
            let connector = tokio_native_tls::TlsConnector::from(connector);
            let tls_stream = connector.connect(host, tcp_stream).await?;

            let request = Request::builder()
                .uri(url)
                .header("Host", host)
                .header("Upgrade", "websocket")
                .header("Connection", "Upgrade")
                .header("Sec-WebSocket-Key", &key)
                .header("Sec-WebSocket-Version", "13")
                .body(())?;

            let (ws, _) = tokio_tungstenite::client_async(request, tls_stream).await?;
            ws
        } else {
            tracing::info!("AggTrades connecting directly");

            let tcp_stream = TcpStream::connect(format!("{}:{}", host, port)).await?;
            let connector = native_tls::TlsConnector::new()?;
            let connector = tokio_native_tls::TlsConnector::from(connector);
            let tls_stream = connector.connect(host, tcp_stream).await?;

            let request = Request::builder()
                .uri(url)
                .header("Host", host)
                .header("Upgrade", "websocket")
                .header("Connection", "Upgrade")
                .header("Sec-WebSocket-Key", &key)
                .header("Sec-WebSocket-Version", "13")
                .body(())?;

            let (ws, _) = tokio_tungstenite::client_async(request, tls_stream).await?;
            ws
        };

        let (mut write, mut read) = ws_stream.split();

        tracing::info!("Connected to Binance aggTrade stream for {:?}", self.symbols);

        // 心跳
        let heartbeat = tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                if write.send(Message::Pong(vec![])).await.is_err() {
                    break;
                }
            }
        });

        // 批量缓存，每 100 条或 1 秒写入一次
        let mut batch: Vec<AggTradeRecord> = Vec::with_capacity(100);
        let mut last_flush = tokio::time::Instant::now();

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Some(trade) = self.parse_message(&text) {
                        batch.push(trade);

                        // 批量写入条件
                        if batch.len() >= 100 || last_flush.elapsed().as_secs() >= 1 {
                            if let Err(e) = self.storage.save_agg_trades(&batch) {
                                tracing::error!("Failed to save aggTrades: {}", e);
                            }
                            batch.clear();
                            last_flush = tokio::time::Instant::now();
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    tracing::warn!("AggTrades WebSocket closed");
                    break;
                }
                Err(e) => {
                    tracing::error!("AggTrades WebSocket error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        // 写入剩余数据
        if !batch.is_empty() {
            let _ = self.storage.save_agg_trades(&batch);
        }

        heartbeat.abort();
        Ok(())
    }

    fn parse_message(&self, text: &str) -> Option<AggTradeRecord> {
        // 组合流格式: {"stream":"btcusdt@aggTrade","data":{...}}
        #[derive(Deserialize)]
        struct StreamWrapper {
            data: AggTradeEvent,
        }

        let wrapper: StreamWrapper = serde_json::from_str(text).ok()?;
        let event = wrapper.data;

        let price: f64 = event.price.parse().ok()?;
        let quantity: f64 = event.quantity.parse().ok()?;

        Some(AggTradeRecord {
            symbol: event.symbol,
            price,
            quantity,
            quote_qty: price * quantity,
            is_buyer_maker: event.is_buyer_maker,
            timestamp: event.trade_time,
        })
    }
}

/// 启动 AggTrades 收集器
pub fn spawn_agg_trades_collector(
    ws_url: &str,
    storage: Arc<Storage>,
    symbols: Vec<String>,
) -> tokio::task::JoinHandle<()> {
    let collector = Arc::new(AggTradesCollector::new(ws_url, storage, symbols));

    tokio::spawn(async move {
        if let Err(e) = collector.start().await {
            tracing::error!("AggTrades collector stopped: {}", e);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_estimate_leverage() {
        // 模拟数据
        let collector = ForceOrderCollector {
            ws_url: String::new(),
            kline_client: Arc::new(BinanceKlineClient::new("https://fapi.binance.com")),
            storage: Arc::new(Storage::new(":memory:").unwrap()),
            symbols: vec![],
        };

        // 多头清算：市价 100000，清算价 95000，差距 5% → 约 20x
        let lev = collector.estimate_leverage(100000.0, 95000.0, true);
        assert!(lev >= 15 && lev <= 25, "Expected ~20x, got {}x", lev);

        // 空头清算：市价 100000，清算价 105000，差距 5% → 约 20x
        let lev = collector.estimate_leverage(100000.0, 105000.0, false);
        assert!(lev >= 15 && lev <= 25, "Expected ~20x, got {}x", lev);

        // 高杠杆：差距 1% → 约 100x
        let lev = collector.estimate_leverage(100000.0, 99000.0, true);
        assert!(lev >= 50 && lev <= 100, "Expected ~100x, got {}x", lev);
    }
}
