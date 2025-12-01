//! REST API 和 WebSocket API 模块

use std::sync::Arc;
use axum::{
    extract::{Path, Query, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{info, warn, error};

use crate::types::{KlineSimple, SubscriptionKey, WsMessage};
use crate::ws::{ClientSession, KlineManager};

/// 应用状态
pub struct AppState {
    pub manager: Arc<KlineManager>,
}

/// 创建 API 路由
pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/klines/:symbol/:timeframe", get(get_klines))
        .route("/ws", get(ws_handler))
        .route("/health", get(health_check))
        .with_state(state)
}

/// 健康检查
async fn health_check() -> &'static str {
    "OK"
}

/// K线查询参数
#[derive(Deserialize)]
struct KlineQuery {
    limit: Option<i64>,
    end_time: Option<i64>,
}

/// K线响应
#[derive(Serialize)]
struct KlineResponse {
    symbol: String,
    timeframe: String,
    klines: Vec<KlineSimple>,
}

/// 获取K线数据（REST API）
/// 支持 limit 参数（默认500，最大5000）
async fn get_klines(
    State(state): State<Arc<AppState>>,
    Path((symbol, timeframe)): Path<(String, String)>,
    Query(query): Query<KlineQuery>,
) -> Json<KlineResponse> {
    let symbol = symbol.to_uppercase();
    let limit = query.limit.unwrap_or(500).min(5000) as usize;

    // 优先从缓存获取
    let mut klines = state
        .manager
        .get_cached_klines(&symbol, &timeframe)
        .await
        .unwrap_or_else(|| vec![]);

    // 应用 limit 参数（保留最新的 limit 条）
    if klines.len() > limit {
        klines = klines.split_off(klines.len() - limit);
    }

    Json(KlineResponse {
        symbol,
        timeframe,
        klines,
    })
}

/// WebSocket 处理器
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// 处理 WebSocket 连接
async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_sink, mut ws_stream) = socket.split();

    // 创建客户端会话
    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<WsMessage>();
    let session = Arc::new(tokio::sync::RwLock::new(ClientSession::new(session_id.clone(), tx)));

    info!("Client connected: {}", session_id);

    // 订阅 K线更新广播
    let mut broadcast_rx = state.manager.subscribe_updates();

    // 发送消息到客户端的任务
    let send_session = Arc::clone(&session);
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // 处理发送队列
                Some(msg) = rx.recv() => {
                    let json = serde_json::to_string(&msg).unwrap();
                    if ws_sink.send(Message::Text(json)).await.is_err() {
                        break;
                    }
                }
                // 处理广播消息
                Ok((key, kline)) = broadcast_rx.recv() => {
                    let s = send_session.read().await;
                    if s.is_subscribed(&key) {
                        let msg = WsMessage::KlineUpdate(kline);
                        let json = serde_json::to_string(&msg).unwrap();
                        drop(s);
                        if ws_sink.send(Message::Text(json)).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
    });

    // 处理客户端消息
    let recv_session = Arc::clone(&session);
    let recv_state = Arc::clone(&state);
    while let Some(Ok(msg)) = ws_stream.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                    handle_client_message(ws_msg, &recv_session, &recv_state).await;
                } else {
                    warn!("Invalid message from client: {}", text);
                }
            }
            Message::Ping(data) => {
                let s = recv_session.read().await;
                let _ = s.tx.send(WsMessage::Pong);
                drop(s);
            }
            Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    // 清理
    send_task.abort();
    info!("Client disconnected: {}", session_id);
}

/// 处理客户端消息
async fn handle_client_message(
    msg: WsMessage,
    session: &Arc<tokio::sync::RwLock<ClientSession>>,
    state: &Arc<AppState>,
) {
    match msg {
        WsMessage::Subscribe { symbol, timeframe } => {
            info!("Client subscribing to {}@{}", symbol, timeframe);

            // 初始化订阅并获取历史数据
            match state.manager.init_subscription(&symbol, &timeframe).await {
                Ok(klines) => {
                    // 记录订阅
                    let mut s = session.write().await;
                    s.subscribe(&symbol, &timeframe);

                    // 发送历史数据
                    let history_msg = WsMessage::KlineHistory {
                        symbol: symbol.to_uppercase(),
                        timeframe: timeframe.clone(),
                        klines,
                    };
                    let _ = s.tx.send(history_msg);
                }
                Err(e) => {
                    error!("Failed to init subscription: {}", e);
                    let s = session.read().await;
                    let _ = s.tx.send(WsMessage::Error {
                        message: format!("Failed to subscribe: {}", e),
                    });
                }
            }
        }
        WsMessage::Unsubscribe { symbol, timeframe } => {
            let mut s = session.write().await;
            s.unsubscribe(&symbol, &timeframe);
            info!("Client unsubscribed from {}@{}", symbol, timeframe);
        }
        WsMessage::Ping => {
            let s = session.read().await;
            let _ = s.tx.send(WsMessage::Pong);
        }
        _ => {}
    }
}
