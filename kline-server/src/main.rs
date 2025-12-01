//! K线数据服务器
//!
//! 提供 K 线数据的持久化存储、实时更新和 WebSocket 推送服务

mod api;
mod binance;
mod db;
mod types;
mod ws;

use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use api::{create_router, AppState};
use db::{init_db, KlineRepository};
use ws::KlineManager;

/// 默认订阅的交易对（服务器启动时自动订阅）- 合约 USDC 交易对
const DEFAULT_SUBSCRIPTIONS: &[(&str, &str)] = &[
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env()
            .add_directive("kline_server=info".parse()?)
            .add_directive("tower_http=debug".parse()?))
        .init();

    info!("Starting K-line Server...");

    // 初始化数据库
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite:klines.db?mode=rwc".to_string());
    let pool = init_db(&database_url).await?;
    info!("Database initialized: {}", database_url);

    // 创建 K 线管理器
    let repo = KlineRepository::new(pool);
    let manager = Arc::new(KlineManager::new(repo));

    // 初始化默认订阅
    for (symbol, timeframe) in DEFAULT_SUBSCRIPTIONS {
        if let Err(e) = manager.init_subscription(symbol, timeframe).await {
            tracing::warn!("Failed to init subscription {}@{}: {}", symbol, timeframe, e);
        }
    }

    // 启动 Binance WebSocket（后台任务）
    let ws_manager = Arc::clone(&manager);
    let subscriptions: Vec<_> = DEFAULT_SUBSCRIPTIONS
        .iter()
        .map(|(s, t)| (s.to_string(), t.to_string()))
        .collect();
    tokio::spawn(async move {
        if let Err(e) = ws_manager.start_binance_ws(subscriptions).await {
            tracing::error!("Binance WebSocket error: {}", e);
        }
    });

    // 定期刷新待写入队列
    let flush_manager = Arc::clone(&manager);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(e) = flush_manager.flush_pending_writes().await {
                tracing::warn!("Failed to flush pending writes: {}", e);
            }
        }
    });

    // 创建应用状态
    let state = Arc::new(AppState { manager });

    // 配置 CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // 创建路由
    let app = create_router(state).layer(cors);

    // 启动服务器
    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3001".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("Server listening on {}", addr);
    info!("WebSocket endpoint: ws://{}/ws", addr);
    info!("REST API endpoint: http://{}/api/klines/:symbol/:timeframe", addr);

    axum::serve(listener, app).await?;

    Ok(())
}
