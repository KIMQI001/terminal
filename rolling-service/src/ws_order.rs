use crate::config::BinanceConfig;
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

/// WebSocket API 请求
#[derive(Debug, Serialize)]
struct WsRequest {
    id: String,
    method: String,
    params: HashMap<String, Value>,
}

/// WebSocket API 响应
#[derive(Debug, Deserialize)]
struct WsResponse {
    id: String,
    status: u16,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<WsError>,
}

#[derive(Debug, Deserialize)]
struct WsError {
    code: i32,
    msg: String,
}

/// 订单响应
#[derive(Debug, Clone)]
pub struct OrderResponse {
    pub order_id: i64,
    pub client_order_id: String,
    pub status: String,
}

/// WebSocket 订单响应（Binance格式）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsOrderResponse {
    order_id: i64,
    client_order_id: String,
    status: String,
}

impl From<WsOrderResponse> for OrderResponse {
    fn from(ws: WsOrderResponse) -> Self {
        Self {
            order_id: ws.order_id,
            client_order_id: ws.client_order_id,
            status: ws.status,
        }
    }
}

/// 持仓信息
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionInfo {
    pub symbol: String,
    pub position_amt: String,
    pub entry_price: String,
    #[serde(rename = "unRealizedProfit")]
    pub unrealized_profit: String,
    pub position_side: String,
}

struct PendingRequest {
    request: WsRequest,
    response_tx: oneshot::Sender<Result<OrderResponse>>,
}

/// WebSocket 订单管理器
#[derive(Clone)]
pub struct WsOrderManager {
    config: BinanceConfig,
    request_tx: mpsc::Sender<PendingRequest>,
    http_client: reqwest::Client,
}

impl WsOrderManager {
    pub fn new(config: BinanceConfig) -> Self {
        let (request_tx, request_rx) = mpsc::channel(100);

        // 启动 WebSocket 客户端
        let ws_config = config.clone();
        tokio::spawn(async move {
            Self::run_websocket_client(ws_config, request_rx).await;
        });

        // HTTP 客户端（用于查询）
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("创建HTTP客户端失败");

        Self {
            config,
            request_tx,
            http_client,
        }
    }

    /// 运行 WebSocket 客户端（持久连接）
    async fn run_websocket_client(
        config: BinanceConfig,
        mut request_rx: mpsc::Receiver<PendingRequest>,
    ) {
        loop {
            info!("连接到 Binance WebSocket API...");

            // WebSocket API 地址
            let ws_url = "wss://ws-fapi.binance.com/ws-fapi/v1".to_string();

            match connect_async(&ws_url).await {
                Ok((ws_stream, _)) => {
                    info!("✓ WebSocket API 连接成功");

                    let (mut write, mut read) = ws_stream.split();
                    let pending_responses: Arc<RwLock<HashMap<String, oneshot::Sender<Result<OrderResponse>>>>> =
                        Arc::new(RwLock::new(HashMap::new()));

                    // 接收响应任务
                    let responses = pending_responses.clone();
                    let response_task = tokio::spawn(async move {
                        while let Some(msg) = read.next().await {
                            match msg {
                                Ok(Message::Text(text)) => {
                                    Self::handle_response(&text, &responses).await;
                                }
                                Ok(Message::Ping(_)) => {
                                    debug!("收到 Ping");
                                }
                                Ok(Message::Pong(_)) => {}
                                Ok(Message::Close(_)) => {
                                    warn!("WebSocket 连接关闭");
                                    break;
                                }
                                Err(e) => {
                                    error!("WebSocket 错误: {}", e);
                                    break;
                                }
                                _ => {}
                            }
                        }
                    });

                    // 发送请求任务
                    let send_result = async {
                        while let Some(pending) = request_rx.recv().await {
                            let request_id = pending.request.id.clone();

                            // 注册 pending response
                            pending_responses.write().await.insert(
                                request_id.clone(),
                                pending.response_tx,
                            );

                            // 发送请求
                            let json = serde_json::to_string(&pending.request)
                                .expect("序列化请求失败");

                            debug!("发送请求: {}", json);

                            if let Err(e) = write.send(Message::Text(json)).await {
                                error!("发送 WebSocket 消息失败: {}", e);
                                break;
                            }
                        }
                        Ok::<(), anyhow::Error>(())
                    }.await;

                    response_task.abort();

                    if send_result.is_err() {
                        warn!("WebSocket 客户端断开，3秒后重连...");
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                }
                Err(e) => {
                    error!("WebSocket 连接失败: {}, 3秒后重试", e);
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }
        }
    }

    /// 处理 WebSocket 响应
    async fn handle_response(
        text: &str,
        pending_responses: &Arc<RwLock<HashMap<String, oneshot::Sender<Result<OrderResponse>>>>>,
    ) {
        debug!("收到响应: {}", text);

        match serde_json::from_str::<WsResponse>(text) {
            Ok(response) => {
                if let Some(tx) = pending_responses.write().await.remove(&response.id) {
                    let result = if response.status == 200 {
                        if let Some(result) = response.result {
                            match serde_json::from_value::<WsOrderResponse>(result) {
                                Ok(ws_order) => Ok(ws_order.into()),
                                Err(e) => Err(anyhow!("解析订单响应失败: {}", e)),
                            }
                        } else {
                            Err(anyhow!("响应中缺少 result 字段"))
                        }
                    } else {
                        if let Some(error) = response.error {
                            Err(anyhow!("API 错误 {}: {}", error.code, error.msg))
                        } else {
                            Err(anyhow!("API 错误，状态码: {}", response.status))
                        }
                    };

                    let _ = tx.send(result);
                }
            }
            Err(e) => {
                warn!("解析响应失败: {}, 原始: {}", e, text);
            }
        }
    }

    /// 生成 HMAC SHA256 签名
    fn generate_signature(&self, params: &HashMap<String, Value>) -> Result<String> {
        let mut keys: Vec<_> = params.keys()
            .filter(|k| k.as_str() != "signature")
            .collect();
        keys.sort();

        let query_string: String = keys.iter()
            .map(|k| {
                let value = match &params[*k] {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    _ => params[*k].to_string(),
                };
                format!("{}={}", k, value)
            })
            .collect::<Vec<_>>()
            .join("&");

        debug!("签名字符串: {}", query_string);

        let mut mac = HmacSha256::new_from_slice(self.config.api_secret.as_bytes())
            .context("HMAC 初始化失败")?;
        mac.update(query_string.as_bytes());
        let result = mac.finalize();

        Ok(hex::encode(result.into_bytes()))
    }

    /// 下限价单（入场单）
    /// is_buy=true: 买单入场（做多）
    /// is_buy=false: 卖单入场（做空）
    pub async fn place_limit_order(
        &self,
        symbol: &str,
        price: f64,
        quantity: f64,
        client_order_id: &str,
        is_buy: bool,
    ) -> Result<OrderResponse> {
        let mut params = HashMap::new();

        let (side, position_side) = if is_buy {
            ("BUY", "LONG")
        } else {
            ("SELL", "SHORT")
        };

        params.insert("apiKey".to_string(), Value::String(self.config.api_key.clone()));
        params.insert("symbol".to_string(), Value::String(symbol.to_string()));
        params.insert("side".to_string(), Value::String(side.to_string()));
        params.insert("type".to_string(), Value::String("LIMIT".to_string()));
        params.insert("quantity".to_string(), Value::String(format!("{:.3}", quantity)));
        params.insert("price".to_string(), Value::String(format!("{:.2}", price)));
        params.insert("timeInForce".to_string(), Value::String("GTC".to_string()));
        params.insert("positionSide".to_string(), Value::String(position_side.to_string()));
        params.insert("newClientOrderId".to_string(), Value::String(client_order_id.to_string()));

        let timestamp = chrono::Utc::now().timestamp_millis();
        params.insert("timestamp".to_string(), Value::Number(timestamp.into()));

        let signature = self.generate_signature(&params)?;
        params.insert("signature".to_string(), Value::String(signature));

        let request_id = Uuid::new_v4().to_string();
        let ws_request = WsRequest {
            id: request_id,
            method: "order.place".to_string(),
            params,
        };

        let (response_tx, response_rx) = oneshot::channel();
        let pending = PendingRequest {
            request: ws_request,
            response_tx,
        };

        self.request_tx.send(pending).await
            .context("发送请求到 WebSocket 客户端失败")?;

        timeout(Duration::from_secs(5), response_rx)
            .await
            .context("等待响应超时")?
            .context("接收响应失败")?
    }

    /// 下止盈单 (TAKE_PROFIT_MARKET) - 使用 Algo Order API
    /// is_buy=false: 卖出止盈（做多平仓）
    /// is_buy=true: 买入止盈（做空平仓）
    pub async fn place_take_profit(
        &self,
        symbol: &str,
        trigger_price: f64,
        quantity: f64,
        client_order_id: &str,
        is_buy: bool,
    ) -> Result<OrderResponse> {
        let (side, position_side) = if is_buy {
            ("BUY", "SHORT")   // 做空止盈：买入平空
        } else {
            ("SELL", "LONG")   // 做多止盈：卖出平多
        };

        let timestamp = chrono::Utc::now().timestamp_millis();
        // 使用通用格式化，保留足够精度，Binance 会自动处理
        let query = format!(
            "algoType=CONDITIONAL&symbol={}&side={}&positionSide={}&type=TAKE_PROFIT_MARKET&quantity={:.3}&triggerPrice={}&clientAlgoId={}&timestamp={}",
            symbol, side, position_side, quantity, trigger_price, client_order_id, timestamp
        );

        let mut mac = HmacSha256::new_from_slice(self.config.api_secret.as_bytes())?;
        mac.update(query.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());

        let url = format!("{}/fapi/v1/algoOrder?{}&signature={}",
                         self.config.api_url, query, signature);

        let resp = self.http_client
            .post(&url)
            .header("X-MBX-APIKEY", &self.config.api_key)
            .send()
            .await?;

        let text = resp.text().await?;

        // Algo Order API 成功时直接返回订单信息，失败时返回 code/msg
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AlgoOrderResp {
            #[serde(default)]
            algo_id: i64,
            #[serde(default)]
            client_algo_id: String,
            #[serde(default)]
            code: i32,
            #[serde(default)]
            msg: String,
        }

        let algo_resp: AlgoOrderResp = serde_json::from_str(&text)
            .context(format!("解析止盈响应失败: {}", text))?;

        // 如果有 algo_id 说明成功
        if algo_resp.algo_id > 0 {
            Ok(OrderResponse {
                order_id: algo_resp.algo_id,
                client_order_id: algo_resp.client_algo_id,
                status: "NEW".to_string(),
            })
        } else {
            Err(anyhow!("API 错误 {}: {}", algo_resp.code, algo_resp.msg))
        }
    }

    /// 下止损单 (STOP_MARKET) - 使用 Algo Order API
    /// is_buy=false: 卖出止损（做多平仓）
    /// is_buy=true: 买入止损（做空平仓）
    pub async fn place_stop_loss(
        &self,
        symbol: &str,
        trigger_price: f64,
        quantity: f64,
        client_order_id: &str,
        is_buy: bool,
    ) -> Result<OrderResponse> {
        let (side, position_side) = if is_buy {
            ("BUY", "SHORT")   // 做空止损：买入平空
        } else {
            ("SELL", "LONG")   // 做多止损：卖出平多
        };

        let timestamp = chrono::Utc::now().timestamp_millis();
        // 使用通用格式化，保留足够精度，Binance 会自动处理
        let query = format!(
            "algoType=CONDITIONAL&symbol={}&side={}&positionSide={}&type=STOP_MARKET&quantity={:.3}&triggerPrice={}&clientAlgoId={}&timestamp={}",
            symbol, side, position_side, quantity, trigger_price, client_order_id, timestamp
        );

        let mut mac = HmacSha256::new_from_slice(self.config.api_secret.as_bytes())?;
        mac.update(query.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());

        let url = format!("{}/fapi/v1/algoOrder?{}&signature={}",
                         self.config.api_url, query, signature);

        let resp = self.http_client
            .post(&url)
            .header("X-MBX-APIKEY", &self.config.api_key)
            .send()
            .await?;

        let text = resp.text().await?;

        // Algo Order API 成功时直接返回订单信息，失败时返回 code/msg
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AlgoOrderResp {
            #[serde(default)]
            algo_id: i64,
            #[serde(default)]
            client_algo_id: String,
            #[serde(default)]
            code: i32,
            #[serde(default)]
            msg: String,
        }

        let algo_resp: AlgoOrderResp = serde_json::from_str(&text)
            .context(format!("解析止损响应失败: {}", text))?;

        // 如果有 algo_id 说明成功
        if algo_resp.algo_id > 0 {
            Ok(OrderResponse {
                order_id: algo_resp.algo_id,
                client_order_id: algo_resp.client_algo_id,
                status: "NEW".to_string(),
            })
        } else {
            Err(anyhow!("API 错误 {}: {}", algo_resp.code, algo_resp.msg))
        }
    }

    /// 取消订单
    pub async fn cancel_order(&self, symbol: &str, client_order_id: &str) -> Result<()> {
        let mut params = HashMap::new();

        params.insert("apiKey".to_string(), Value::String(self.config.api_key.clone()));
        params.insert("symbol".to_string(), Value::String(symbol.to_string()));
        params.insert("origClientOrderId".to_string(), Value::String(client_order_id.to_string()));

        let timestamp = chrono::Utc::now().timestamp_millis();
        params.insert("timestamp".to_string(), Value::Number(timestamp.into()));

        let signature = self.generate_signature(&params)?;
        params.insert("signature".to_string(), Value::String(signature));

        let request_id = Uuid::new_v4().to_string();
        let ws_request = WsRequest {
            id: request_id,
            method: "order.cancel".to_string(),
            params,
        };

        let (response_tx, response_rx) = oneshot::channel();
        let pending = PendingRequest {
            request: ws_request,
            response_tx,
        };

        self.request_tx.send(pending).await
            .context("发送取消请求失败")?;

        let _ = timeout(Duration::from_secs(5), response_rx)
            .await
            .context("等待取消响应超时")?
            .context("接收取消响应失败")?;

        Ok(())
    }

    /// 设置杠杆 (REST API)
    pub async fn set_leverage(&self, symbol: &str, leverage: u32) -> Result<()> {
        let timestamp = chrono::Utc::now().timestamp_millis();
        let query = format!("symbol={}&leverage={}&timestamp={}", symbol, leverage, timestamp);

        let mut mac = HmacSha256::new_from_slice(self.config.api_secret.as_bytes())?;
        mac.update(query.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());

        let url = format!("{}/fapi/v1/leverage?{}&signature={}",
                         self.config.api_url, query, signature);

        let resp = self.http_client
            .post(&url)
            .header("X-MBX-APIKEY", &self.config.api_key)
            .send()
            .await?;

        if resp.status().is_success() {
            info!("杠杆设置成功: {}x", leverage);
            Ok(())
        } else {
            let text = resp.text().await?;
            error!("设置杠杆失败: {}", text);
            Err(anyhow!("设置杠杆失败: {}", text))
        }
    }

    /// 获取当前价格 (REST API)
    pub async fn get_price(&self, symbol: &str) -> Result<f64> {
        let url = format!("{}/fapi/v1/ticker/price?symbol={}", self.config.api_url, symbol);

        let resp = self.http_client.get(&url).send().await?;
        let text = resp.text().await?;

        #[derive(Deserialize)]
        struct PriceResp {
            price: String,
        }
        let price_resp: PriceResp = serde_json::from_str(&text)?;
        Ok(price_resp.price.parse()?)
    }

    /// 获取持仓信息 (REST API)
    pub async fn get_position(&self, symbol: &str) -> Result<Option<PositionInfo>> {
        let timestamp = chrono::Utc::now().timestamp_millis();
        let query = format!("symbol={}&timestamp={}", symbol, timestamp);

        let mut mac = HmacSha256::new_from_slice(self.config.api_secret.as_bytes())?;
        mac.update(query.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());

        let url = format!("{}/fapi/v2/positionRisk?{}&signature={}",
                         self.config.api_url, query, signature);

        let resp = self.http_client
            .get(&url)
            .header("X-MBX-APIKEY", &self.config.api_key)
            .send()
            .await?;

        let text = resp.text().await?;
        let positions: Vec<PositionInfo> = serde_json::from_str(&text)?;

        let long_pos = positions.into_iter()
            .find(|p| p.position_side == "LONG" && p.position_amt.parse::<f64>().unwrap_or(0.0) > 0.0);

        Ok(long_pos)
    }

    /// 获取 WebSocket URL（用于价格流）
    pub fn get_ws_url(&self) -> &str {
        &self.config.ws_url
    }
}
