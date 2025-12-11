use crate::config::BinanceConfig;
use anyhow::{anyhow, Result};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use serde::Deserialize;
use tokio::sync::mpsc;
use futures_util::StreamExt;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info, warn};
use std::time::Duration;

type HmacSha256 = Hmac<Sha256>;

/// 订单更新事件
#[derive(Debug, Clone)]
pub struct OrderUpdate {
    pub symbol: String,
    pub client_order_id: String,
    pub side: String,
    pub order_status: String,
    pub filled_price: f64,
    pub filled_qty: f64,
    pub order_type: String,
}

/// WebSocket 订单更新消息
#[derive(Debug, Deserialize)]
struct WsAccountUpdate {
    #[serde(rename = "e")]
    event_type: String,
    #[serde(rename = "o")]
    order: Option<WsOrderData>,
}

#[derive(Debug, Deserialize)]
struct WsOrderData {
    #[serde(rename = "s")]
    symbol: String,
    #[serde(rename = "c")]
    client_order_id: String,
    #[serde(rename = "S")]
    side: String,
    #[serde(rename = "o")]
    order_type: String,
    #[serde(rename = "X")]
    order_status: String,
    #[serde(rename = "ap")]
    avg_price: String,
    #[serde(rename = "z")]
    filled_qty: String,
    #[serde(rename = "L")]
    last_filled_price: String,
    #[serde(rename = "l")]
    last_filled_qty: String,
}

/// 用户数据流管理
pub struct UserStream {
    config: BinanceConfig,
    client: reqwest::Client,
}

impl UserStream {
    pub fn new(config: BinanceConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    /// 生成签名
    fn sign(&self, query: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(self.config.api_secret.as_bytes())
            .expect("HMAC error");
        mac.update(query.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// 获取时间戳
    fn timestamp() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    /// 获取 listenKey
    async fn get_listen_key(&self) -> Result<String> {
        let url = format!("{}/fapi/v1/listenKey", self.config.api_url);

        let resp = self.client
            .post(&url)
            .header("X-MBX-APIKEY", &self.config.api_key)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            #[derive(Deserialize)]
            struct ListenKeyResp {
                #[serde(rename = "listenKey")]
                listen_key: String,
            }
            let resp: ListenKeyResp = serde_json::from_str(&text)?;
            Ok(resp.listen_key)
        } else {
            Err(anyhow!("获取listenKey失败: {}", text))
        }
    }

    /// 延长 listenKey 有效期
    async fn keepalive_listen_key(&self, listen_key: &str) -> Result<()> {
        let url = format!("{}/fapi/v1/listenKey", self.config.api_url);

        let resp = self.client
            .put(&url)
            .header("X-MBX-APIKEY", &self.config.api_key)
            .query(&[("listenKey", listen_key)])
            .send()
            .await?;

        if resp.status().is_success() {
            debug!("listenKey已续期");
            Ok(())
        } else {
            let text = resp.text().await?;
            Err(anyhow!("续期listenKey失败: {}", text))
        }
    }

    /// 启动用户数据流，返回订单更新通道
    pub async fn start(&self) -> Result<mpsc::Receiver<OrderUpdate>> {
        let (tx, rx) = mpsc::channel(100);

        // 获取 listenKey
        let listen_key = self.get_listen_key().await?;
        info!("获取到listenKey");

        // 构建 WebSocket URL
        let ws_url = format!("{}/{}", self.config.ws_url, listen_key);

        let config = self.config.clone();
        let listen_key_clone = listen_key.clone();

        // 启动 WebSocket 连接
        tokio::spawn(async move {
            let user_stream = UserStream::new(config.clone());

            // 启动 keepalive 任务
            let listen_key_keepalive = listen_key_clone.clone();
            let config_keepalive = config.clone();
            tokio::spawn(async move {
                let user_stream = UserStream::new(config_keepalive);
                loop {
                    tokio::time::sleep(Duration::from_secs(30 * 60)).await; // 30分钟
                    if let Err(e) = user_stream.keepalive_listen_key(&listen_key_keepalive).await {
                        error!("listenKey续期失败: {}", e);
                    }
                }
            });

            // WebSocket 连接循环
            loop {
                match connect_async(&ws_url).await {
                    Ok((ws_stream, _)) => {
                        info!("用户数据流已连接");
                        let (_, mut read) = ws_stream.split();

                        while let Some(msg) = read.next().await {
                            match msg {
                                Ok(Message::Text(text)) => {
                                    // 解析消息
                                    if let Ok(update) = serde_json::from_str::<WsAccountUpdate>(&text) {
                                        if update.event_type == "ORDER_TRADE_UPDATE" {
                                            if let Some(order) = update.order {
                                                let order_update = OrderUpdate {
                                                    symbol: order.symbol,
                                                    client_order_id: order.client_order_id,
                                                    side: order.side,
                                                    order_status: order.order_status,
                                                    filled_price: order.last_filled_price.parse().unwrap_or(0.0),
                                                    filled_qty: order.last_filled_qty.parse().unwrap_or(0.0),
                                                    order_type: order.order_type,
                                                };

                                                debug!("订单更新: {:?}", order_update);

                                                if tx.send(order_update).await.is_err() {
                                                    error!("发送订单更新失败，通道已关闭");
                                                    return;
                                                }
                                            }
                                        }
                                    }
                                }
                                Ok(Message::Ping(data)) => {
                                    debug!("收到Ping");
                                }
                                Err(e) => {
                                    error!("用户数据流错误: {}", e);
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(e) => {
                        error!("用户数据流连接失败: {}", e);
                    }
                }

                warn!("用户数据流断开，5秒后重连...");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });

        Ok(rx)
    }
}
