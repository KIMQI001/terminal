//! K线数据服务器
//!
//! 提供 K 线数据的持久化存储、实时更新和 WebSocket 推送服务
//!
//! ## 架构说明
//! - exchanges/ 模块：交易所抽象层，支持多个 CEX（Binance, OKX, Bybit）
//! - 使用 trait object 实现交易所接口的多态
//! - 支持未来扩展 DEX（Uniswap, Raydium 等）

mod api;
mod coinank_relay;
mod db;
mod exchanges;
mod types;
mod ws;

// 保留旧的 binance 模块用于向后兼容
mod binance;

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
        .with(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("kline_server=info".parse()?)
                .add_directive("tower_http=debug".parse()?),
        )
        .init();

    info!("Starting K-line Server...");
    info!("Exchange abstraction layer enabled - supporting multiple exchanges");

    // 初始化数据库
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite:klines.db?mode=rwc".to_string());
    let pool = init_db(&database_url).await?;
    info!("Database initialized: {}", database_url);

    // 创建 K 线管理器
    let repo = KlineRepository::new(pool);
    let manager = Arc::new(KlineManager::new(repo));

    // 注册 Binance 交易所（使用新的抽象层）
    // 未来可以在这里添加更多交易所：
    // - manager.register_exchange(Arc::new(OkxExchange::new(...))).await;
    // - manager.register_exchange(Arc::new(BybitExchange::new(...))).await;
    let binance_exchange = exchanges::binance::BinanceExchange::default_futures();
    manager.register_exchange(Arc::new(binance_exchange)).await;
    info!("Registered Binance Futures exchange");

    // 初始化默认订阅
    for (symbol, timeframe) in DEFAULT_SUBSCRIPTIONS {
        if let Err(e) = manager.init_subscription(symbol, timeframe).await {
            tracing::warn!("Failed to init subscription {}@{}: {}", symbol, timeframe, e);
        }
    }

    // 启动 Binance WebSocket（后台任务）
    // 使用旧的 start_binance_ws 方法以保持向后兼容
    // 未来可以改用：manager.start_exchange_ws(ExchangeType::Binance, subscriptions)
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

    // 创建 CoinAnk 中转状态
    let coinank_state = Arc::new(coinank_relay::CoinankRelayState::new());
    info!("CoinAnk relay service initialized");

    // 配置 CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // 创建路由 (合并 K线路由和 CoinAnk 中转路由)
    let coinank_router = coinank_relay::create_coinank_router(Arc::clone(&coinank_state));
    let app = create_router(state)
        .merge(coinank_router)
        .layer(cors);

    // 启动服务器
    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3001".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("Server listening on {}", addr);
    info!("WebSocket endpoint: ws://{}/ws", addr);
    info!(
        "REST API endpoint: http://{}/api/klines/:symbol/:timeframe",
        addr
    );
    info!("Supported exchanges: Binance (OKX and Bybit coming soon)");
    info!("CoinAnk relay endpoints:");
    info!("  - Tampermonkey: ws://{}/ws/coinank/tampermonkey", addr);
    info!("  - API: ws://{}/ws/coinank/api", addr);
    info!("  - Status: http://{}/ws/coinank/status", addr);

    axum::serve(listener, app).await?;

    Ok(())
}
