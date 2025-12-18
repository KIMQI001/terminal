use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Json,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::config::Config;
use crate::kline::BinanceKlineClient;
use crate::liquidation::{HeatmapData, HeatmapGenerator, LeverageModel};

/// 应用状态
pub struct AppState {
    pub config: Config,
    pub kline_client: BinanceKlineClient,
    pub leverage_model: RwLock<LeverageModel>,
}

/// 热力图请求参数
#[derive(Debug, Deserialize)]
pub struct HeatmapQuery {
    pub symbol: Option<String>,
    pub interval: Option<String>,
}

/// API 响应包装
#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(msg: &str) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(msg.to_string()),
        }
    }
}

/// 创建路由
pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/liquidation/heatmap", get(get_heatmap))
        .route("/api/liquidation/leverage-stats", get(get_leverage_stats))
        .route("/health", get(health_check))
        .with_state(state)
}

/// 获取热力图数据
async fn get_heatmap(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HeatmapQuery>,
) -> Result<Json<ApiResponse<HeatmapData>>, (StatusCode, String)> {
    let symbol = params.symbol.unwrap_or_else(|| "BTCUSDT".to_string());
    let _interval = params.interval.unwrap_or_else(|| "1d".to_string());

    // 计算需要获取的 K线数量
    // 1h K线，7天 = 168 根
    let kline_count = state.config.calculation.lookback_days * 24;

    // 获取 K线数据
    let klines = state
        .kline_client
        .get_klines(&symbol, &state.config.calculation.kline_interval, kline_count)
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch klines: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    // 获取当前价格
    let current_price = state
        .kline_client
        .get_price(&symbol)
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch price: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    // 生成热力图
    let model = state.leverage_model.read().await;
    let generator = HeatmapGenerator::new(model.clone(), state.config.calculation.price_bucket_size);
    let heatmap = generator.generate(&symbol, &klines, current_price);

    tracing::info!(
        "Generated heatmap for {}: {} price levels, long_total={:.0}, short_total={:.0}",
        symbol,
        heatmap.prices.len(),
        heatmap.long.iter().sum::<f64>(),
        heatmap.short.iter().sum::<f64>()
    );

    Ok(Json(ApiResponse::success(heatmap)))
}

/// 获取杠杆分布统计
#[derive(Serialize)]
struct LeverageStats {
    symbol: String,
    distribution: std::collections::HashMap<String, f64>,
    use_dynamic: bool,
}

async fn get_leverage_stats(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HeatmapQuery>,
) -> Json<ApiResponse<LeverageStats>> {
    let symbol = params.symbol.unwrap_or_else(|| "BTCUSDT".to_string());
    let model = state.leverage_model.read().await;

    let distribution: std::collections::HashMap<String, f64> = model
        .get_distribution()
        .iter()
        .map(|(k, v)| (format!("{}x", k), *v))
        .collect();

    Json(ApiResponse::success(LeverageStats {
        symbol,
        distribution,
        use_dynamic: state.config.leverage.use_dynamic,
    }))
}

/// 健康检查
async fn health_check() -> &'static str {
    "OK"
}
