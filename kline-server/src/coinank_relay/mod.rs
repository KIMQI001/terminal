//! CoinAnk 数据中转服务
//!
//! 架构:
//! - 油猴脚本连接到 /ws/coinank/tampermonkey
//! - API 客户端连接到 /ws/coinank/api
//! - 中转服务负责转发请求和响应

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use axum::{
    extract::{WebSocketUpgrade, State, Query, ws::{Message, WebSocket}},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tracing::{info, warn, debug};

/// 中转服务状态
pub struct CoinankRelayState {
    /// 油猴客户端连接 (只保留一个)
    tampermonkey_client: Arc<RwLock<Option<TampermonkeyClient>>>,
    /// API 客户端等待的请求 (request_id -> sender)
    pending_requests: Arc<RwLock<HashMap<String, PendingRequest>>>,
}

/// 油猴客户端
struct TampermonkeyClient {
    id: String,
    tx: mpsc::UnboundedSender<String>,
}

/// 待处理的请求
struct PendingRequest {
    tx: tokio::sync::oneshot::Sender<RelayMessage>,
}

/// 中转消息协议
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum RelayMessage {
    /// API -> 中转: 请求数据
    Fetch {
        symbol: String,
        interval: String,
        request_id: String,
    },
    /// 油猴 -> 中转: 返回数据
    Data {
        request_id: String,
        symbol: String,
        interval: String,
        data: serde_json::Value,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        timestamp: Option<String>,
    },
    /// 中转 -> API: 错误响应
    Error {
        request_id: String,
        error: String,
        success: bool,
    },
    /// 心跳
    Ping,
    Pong,
}

impl CoinankRelayState {
    pub fn new() -> Self {
        Self {
            tampermonkey_client: Arc::new(RwLock::new(None)),
            pending_requests: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 检查油猴客户端是否连接
    pub async fn is_tampermonkey_connected(&self) -> bool {
        self.tampermonkey_client.read().await.is_some()
    }

    /// 发送请求到油猴客户端并等待响应
    pub async fn send_request(
        &self,
        symbol: &str,
        interval: &str,
        timeout_secs: u64,
        request_id: &str,
    ) -> Result<RelayMessage, String> {
        // 使用传入的请求 ID
        let request_id = request_id.to_string();

        // 创建响应通道
        let (tx, rx) = tokio::sync::oneshot::channel();

        // 注册待处理请求
        {
            let mut pending = self.pending_requests.write().await;
            pending.insert(request_id.clone(), PendingRequest { tx });
        }

        // 发送请求到油猴客户端 (在独立作用域内获取锁)
        {
            let guard = self.tampermonkey_client.read().await;
            let client = guard.as_ref().ok_or("No tampermonkey client connected")?;

            let msg = RelayMessage::Fetch {
                symbol: symbol.to_string(),
                interval: interval.to_string(),
                request_id: request_id.clone(),
            };

            let json = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
            client.tx.send(json).map_err(|e| e.to_string())?;
        } // guard 在这里自动释放

        // 等待响应（带超时）
        let result = tokio::time::timeout(
            tokio::time::Duration::from_secs(timeout_secs),
            rx,
        )
        .await;

        // 清理待处理请求
        {
            let mut pending = self.pending_requests.write().await;
            pending.remove(&request_id);
        }

        match result {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("Response channel closed".to_string()),
            Err(_) => Err("Request timeout".to_string()),
        }
    }

    /// 处理油猴客户端的响应
    async fn handle_tampermonkey_response(&self, msg: RelayMessage) {
        let request_id = match &msg {
            RelayMessage::Data { request_id, .. } => request_id.clone(),
            RelayMessage::Error { request_id, .. } => request_id.clone(),
            _ => return,
        };

        let mut pending = self.pending_requests.write().await;
        if let Some(req) = pending.remove(&request_id) {
            let _ = req.tx.send(msg);
        }
    }
}

/// HTTP API 请求参数
#[derive(Debug, Deserialize)]
pub struct FetchQuery {
    symbol: String,
    interval: String,
}

/// HTTP API 响应
#[derive(Debug, Serialize)]
pub struct FetchResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    symbol: String,
    interval: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
}

/// 创建 CoinAnk 中转路由
pub fn create_coinank_router(state: Arc<CoinankRelayState>) -> Router {
    Router::new()
        .route("/ws/coinank/tampermonkey", get(tampermonkey_ws_handler))
        .route("/ws/coinank/api", get(api_ws_handler))
        .route("/ws/coinank/status", get(status_handler))
        .route("/api/coinank/fetch", get(http_fetch_handler))
        .with_state(state)
}

/// HTTP API 获取数据（替代 WebSocket）
async fn http_fetch_handler(
    State(state): State<Arc<CoinankRelayState>>,
    Query(params): Query<FetchQuery>,
) -> Json<FetchResponse> {
    let request_id = uuid::Uuid::new_v4().to_string();
    info!("[CoinAnk HTTP] Fetch request: {}@{}", params.symbol, params.interval);

    match state.send_request(&params.symbol, &params.interval, 30, &request_id).await {
        Ok(RelayMessage::Data { data, timestamp, .. }) => {
            Json(FetchResponse {
                success: true,
                data: Some(data),
                error: None,
                symbol: params.symbol,
                interval: params.interval,
                timestamp,
            })
        }
        Ok(RelayMessage::Error { error, .. }) => {
            Json(FetchResponse {
                success: false,
                data: None,
                error: Some(error),
                symbol: params.symbol,
                interval: params.interval,
                timestamp: None,
            })
        }
        Ok(_) => {
            Json(FetchResponse {
                success: false,
                data: None,
                error: Some("Unexpected response type".to_string()),
                symbol: params.symbol,
                interval: params.interval,
                timestamp: None,
            })
        }
        Err(e) => {
            Json(FetchResponse {
                success: false,
                data: None,
                error: Some(e),
                symbol: params.symbol,
                interval: params.interval,
                timestamp: None,
            })
        }
    }
}

/// 状态检查
async fn status_handler(State(state): State<Arc<CoinankRelayState>>) -> impl IntoResponse {
    let connected = state.is_tampermonkey_connected().await;
    if connected {
        "Tampermonkey client connected"
    } else {
        "No tampermonkey client"
    }
}

/// 油猴脚本 WebSocket 处理器
async fn tampermonkey_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<CoinankRelayState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_tampermonkey_socket(socket, state))
}

/// 处理油猴脚本连接
async fn handle_tampermonkey_socket(socket: WebSocket, state: Arc<CoinankRelayState>) {
    let (mut ws_sink, mut ws_stream) = socket.split();

    let client_id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    info!("[CoinAnk] Tampermonkey client connected: {}", client_id);

    // 替换现有的油猴客户端
    {
        let mut client = state.tampermonkey_client.write().await;
        *client = Some(TampermonkeyClient {
            id: client_id.clone(),
            tx,
        });
    }

    // 发送消息到油猴客户端的任务
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // 处理油猴客户端消息
    while let Some(Ok(msg)) = ws_stream.next().await {
        match msg {
            Message::Text(text) => {
                debug!("[CoinAnk] Received from tampermonkey: {}", &text[..text.len().min(200)]);

                if let Ok(relay_msg) = serde_json::from_str::<RelayMessage>(&text) {
                    match &relay_msg {
                        RelayMessage::Data { request_id, symbol, success, .. } => {
                            info!("[CoinAnk] Data response for {}: {} (success: {})", symbol, request_id, success);
                            state.handle_tampermonkey_response(relay_msg).await;
                        }
                        RelayMessage::Error { request_id, error, .. } => {
                            warn!("[CoinAnk] Error response {}: {}", request_id, error);
                            state.handle_tampermonkey_response(relay_msg).await;
                        }
                        RelayMessage::Pong => {
                            debug!("[CoinAnk] Pong from tampermonkey");
                        }
                        _ => {}
                    }
                }
            }
            Message::Ping(_) => {
                // 自动回复 pong (axum 已处理)
            }
            Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    // 清理
    send_task.abort();
    {
        let mut client = state.tampermonkey_client.write().await;
        if let Some(c) = client.as_ref() {
            if c.id == client_id {
                *client = None;
            }
        }
    }
    info!("[CoinAnk] Tampermonkey client disconnected: {}", client_id);
}

/// API 客户端 WebSocket 处理器
async fn api_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<CoinankRelayState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_api_socket(socket, state))
}

/// 处理 API 客户端连接
async fn handle_api_socket(socket: WebSocket, state: Arc<CoinankRelayState>) {
    let (mut ws_sink, mut ws_stream) = socket.split();

    let client_id = uuid::Uuid::new_v4().to_string();
    info!("[CoinAnk] API client connected: {}", client_id);

    while let Some(Ok(msg)) = ws_stream.next().await {
        match msg {
            Message::Text(text) => {
                debug!("[CoinAnk] API request: {}", text);

                if let Ok(relay_msg) = serde_json::from_str::<RelayMessage>(&text) {
                    match relay_msg {
                        RelayMessage::Fetch { symbol, interval, request_id } => {
                            info!("[CoinAnk] Fetch request: {}@{} ({})", symbol, interval, request_id);

                            // 转发请求到油猴客户端
                            let response = match state.send_request(&symbol, &interval, 30, &request_id).await {
                                Ok(data) => data,
                                Err(e) => RelayMessage::Error {
                                    request_id,
                                    error: e,
                                    success: false,
                                },
                            };

                            let json = serde_json::to_string(&response).unwrap();
                            if ws_sink.send(Message::Text(json)).await.is_err() {
                                break;
                            }
                        }
                        RelayMessage::Ping => {
                            let pong = serde_json::to_string(&RelayMessage::Pong).unwrap();
                            let _ = ws_sink.send(Message::Text(pong)).await;
                        }
                        _ => {}
                    }
                }
            }
            Message::Ping(_) => {}
            Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    info!("[CoinAnk] API client disconnected: {}", client_id);
}
