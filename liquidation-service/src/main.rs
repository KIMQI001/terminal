mod api;
mod collector;
mod config;
mod kline;
mod liquidation;
mod storage;

use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use api::{create_router, AppState};
use config::Config;
use kline::BinanceKlineClient;
use liquidation::LeverageModel;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    // 加载配置
    let config = Config::load("config.toml")?;
    tracing::info!("Loaded config: {:?}", config.server);

    // 创建杠杆模型
    let leverage_model = if config.leverage.use_dynamic {
        // TODO: 从数据库加载学习到的分布
        LeverageModel::new_default()
    } else {
        LeverageModel::from_config(config.leverage.get_parsed_distribution())
    };

    // 创建 K线客户端
    let kline_client = BinanceKlineClient::new(&config.binance.base_url);

    // 创建应用状态
    let state = Arc::new(AppState {
        config: config.clone(),
        kline_client,
        leverage_model: RwLock::new(leverage_model),
    });

    // 创建路由
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = create_router(state).layer(cors);

    // 启动服务器
    let addr = format!("{}:{}", config.server.host, config.server.port);
    tracing::info!("Starting liquidation-service on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
