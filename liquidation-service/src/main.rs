mod api;
mod collector;
mod config;
mod kline;
mod liquidation;
mod storage;

use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use api::{create_router, AppState};
use collector::{spawn_collector, spawn_agg_trades_collector};
use config::Config;
use kline::BinanceKlineClient;
use storage::Storage;

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

    // 创建存储
    let storage = Arc::new(Storage::new(&config.storage.db_path)?);
    tracing::info!("Database initialized at {}", config.storage.db_path);

    // 创建 K线客户端
    let kline_client = Arc::new(BinanceKlineClient::new(&config.binance.base_url));

    // 创建应用状态（使用固定杠杆档位，无需 leverage_model）
    let state = Arc::new(AppState {
        config: config.clone(),
        kline_client: kline_client.clone(),
        storage: storage.clone(),
    });

    // 启动爆仓数据收集器（仍然用于统计分析）
    if config.leverage.use_dynamic {
        tracing::info!("Starting force order collector for statistics...");
        let _collector_handle = spawn_collector(
            &config.binance.ws_url,
            kline_client.clone(),
            storage.clone(),
            config.calculation.symbols.clone(),
        );
    }

    // 启动 aggTrades 收集器（收集真实交易数据用于更精准的清算计算）
    tracing::info!("Starting aggTrades collector for {:?}...", config.calculation.symbols);
    let _agg_trades_handle = spawn_agg_trades_collector(
        &config.binance.ws_url,
        storage.clone(),
        config.calculation.symbols.clone(),
    );

    // 数据保留时长（小时）- 从配置读取
    let retention_hours = config.storage.retention_hours;
    tracing::info!("Data retention: {} hours", retention_hours);

    // 启动时先清理一次旧数据
    match storage.cleanup_old_agg_trades_hours(retention_hours) {
        Ok(deleted) => {
            if deleted > 0 {
                tracing::info!("Startup cleanup: deleted {} old agg_trades (keeping {}h)", deleted, retention_hours);
            }
        }
        Err(e) => tracing::error!("Startup cleanup failed: {}", e),
    }

    // 启动定时清理任务（每小时清理一次）
    let cleanup_storage = storage.clone();
    tokio::spawn(async move {
        const CLEANUP_INTERVAL_SECS: u64 = 3600; // 1 小时

        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(CLEANUP_INTERVAL_SECS)).await;

            match cleanup_storage.cleanup_old_agg_trades_hours(retention_hours) {
                Ok(deleted) => {
                    if deleted > 0 {
                        tracing::info!("Cleanup: deleted {} old agg_trades (keeping {}h)", deleted, retention_hours);
                    }
                }
                Err(e) => {
                    tracing::error!("Cleanup failed: {}", e);
                }
            }
        }
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
    tracing::info!("Using fixed leverage tiers: {:?}", liquidation::LEVERAGE_TIERS);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
