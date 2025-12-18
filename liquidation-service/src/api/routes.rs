use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Json,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::config::Config;
use crate::kline::{AggTrade, BinanceKlineClient};
use crate::liquidation::{HeatmapData, HeatmapGenerator};
use crate::storage::Storage;

/// 应用状态
pub struct AppState {
    pub config: Config,
    pub kline_client: Arc<BinanceKlineClient>,
    pub storage: Arc<Storage>,
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
        .route("/api/liquidation/top", get(get_top_liquidations))
        .route("/api/liquidation/leverage-stats", get(get_leverage_stats))
        .route("/api/liquidation/force-orders", get(get_force_orders))
        .route("/api/liquidation/collector-stats", get(get_collector_stats))
        .route("/api/liquidation/agg-trades-stats", get(get_agg_trades_stats))
        .route("/health", get(health_check))
        .with_state(state)
}

/// 获取热力图数据
/// interval 参数：1d (24小时), 1w (7天)
/// 优先使用 aggTrades 数据（更精确），数据不足时回退到 K 线估算
async fn get_heatmap(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HeatmapQuery>,
) -> Result<Json<ApiResponse<HeatmapData>>, (StatusCode, String)> {
    let symbol = params.symbol.unwrap_or_else(|| "BTCUSDT".to_string());
    let interval = params.interval.unwrap_or_else(|| "1d".to_string());

    // 根据 interval 计算时间范围（毫秒）
    let interval_ms: i64 = match interval.as_str() {
        "1w" => 7 * 24 * 60 * 60 * 1000,  // 7天
        _ => 24 * 60 * 60 * 1000,          // 默认 1天
    };

    // 获取当前价格
    let current_price = state
        .kline_client
        .get_price(&symbol)
        .await
        .map_err(|e| {
            tracing::error!("Failed to fetch price: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    let generator = HeatmapGenerator::new(state.config.calculation.price_bucket_size);

    // 检查 aggTrades 数据是否足够
    let now = chrono::Utc::now().timestamp_millis();
    let start_time = now - interval_ms;

    let oldest_time = state.storage.get_agg_trades_min_time(&symbol).unwrap_or(None);
    let use_agg_trades = oldest_time.map(|t| t <= start_time).unwrap_or(false);

    let (heatmap, data_source) = if use_agg_trades {
        // 使用 aggTrades 数据（更精确）
        let trades_records = state
            .storage
            .get_agg_trades(&symbol, start_time, now)
            .map_err(|e| {
                tracing::error!("Failed to fetch aggTrades: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
            })?;

        // 转换为 AggTrade 格式
        let trades: Vec<AggTrade> = trades_records
            .into_iter()
            .map(|r| AggTrade {
                price: r.price,
                quantity: r.quantity,
                quote_qty: r.quote_qty,
                timestamp: r.timestamp,
                is_buyer_maker: r.is_buyer_maker,
            })
            .collect();

        let heatmap = generator.generate_from_trades(&symbol, &trades, current_price);
        (heatmap, format!("aggTrades({})", trades.len()))
    } else {
        // 回退到 K 线估算
        let kline_count = match interval.as_str() {
            "1w" => 168,  // 7天 * 24小时
            _ => 24,       // 默认 1天
        };

        let klines = state
            .kline_client
            .get_klines(&symbol, "1h", kline_count)
            .await
            .map_err(|e| {
                tracing::error!("Failed to fetch klines: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
            })?;

        let heatmap = generator.generate_from_klines(&symbol, &klines, current_price);
        (heatmap, format!("klines({})", klines.len()))
    };

    tracing::info!(
        "Generated heatmap for {} ({}): {} price levels, source={}, long_total={:.0}, short_total={:.0}",
        symbol,
        interval,
        heatmap.prices.len(),
        data_source,
        heatmap.long.iter().sum::<f64>(),
        heatmap.short.iter().sum::<f64>()
    );

    Ok(Json(ApiResponse::success(heatmap)))
}

/// Top 清算价位
#[derive(Serialize)]
struct TopLiquidation {
    price: f64,
    value: f64,
}

#[derive(Serialize)]
struct TopLiquidationsResponse {
    symbol: String,
    #[serde(rename = "lastPrice")]
    last_price: f64,
    /// 多头清算（价格下跌触发，在当前价格以下）
    long: Vec<TopLiquidation>,
    /// 空头清算（价格上涨触发，在当前价格以上）
    short: Vec<TopLiquidation>,
}

#[derive(Debug, Deserialize)]
pub struct TopQuery {
    pub symbol: Option<String>,
    pub limit: Option<usize>,
    pub interval: Option<String>,
}

/// 获取 Top 清算价位排名
/// interval 参数：1d (24小时), 1w (7天)
/// 优先使用 aggTrades 数据，数据不足时回退到 K 线估算
async fn get_top_liquidations(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TopQuery>,
) -> Result<Json<ApiResponse<TopLiquidationsResponse>>, (StatusCode, String)> {
    let symbol = params.symbol.unwrap_or_else(|| "BTCUSDT".to_string());
    let limit = params.limit.unwrap_or(10).min(50);
    let interval = params.interval.unwrap_or_else(|| "1d".to_string());

    // 根据 interval 计算时间范围（毫秒）
    let interval_ms: i64 = match interval.as_str() {
        "1w" => 7 * 24 * 60 * 60 * 1000,
        _ => 24 * 60 * 60 * 1000,
    };

    let current_price = state
        .kline_client
        .get_price(&symbol)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let generator = HeatmapGenerator::new(state.config.calculation.price_bucket_size);

    // 检查 aggTrades 数据是否足够
    let now = chrono::Utc::now().timestamp_millis();
    let start_time = now - interval_ms;

    let oldest_time = state.storage.get_agg_trades_min_time(&symbol).unwrap_or(None);
    let use_agg_trades = oldest_time.map(|t| t <= start_time).unwrap_or(false);

    let heatmap = if use_agg_trades {
        // 使用 aggTrades 数据
        let trades_records = state
            .storage
            .get_agg_trades(&symbol, start_time, now)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let trades: Vec<AggTrade> = trades_records
            .into_iter()
            .map(|r| AggTrade {
                price: r.price,
                quantity: r.quantity,
                quote_qty: r.quote_qty,
                timestamp: r.timestamp,
                is_buyer_maker: r.is_buyer_maker,
            })
            .collect();

        tracing::info!("Top liquidations using aggTrades: {} records", trades.len());
        generator.generate_from_trades(&symbol, &trades, current_price)
    } else {
        // 回退到 K 线估算
        let kline_count = match interval.as_str() {
            "1w" => 168,
            _ => 24,
        };

        let klines = state
            .kline_client
            .get_klines(&symbol, "1h", kline_count)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        tracing::info!("Top liquidations using klines: {} records", klines.len());
        generator.generate_from_klines(&symbol, &klines, current_price)
    };

    // 分别收集 long 和 short
    let mut long_levels: Vec<TopLiquidation> = Vec::new();
    let mut short_levels: Vec<TopLiquidation> = Vec::new();

    for (i, &value) in heatmap.long.iter().enumerate() {
        if value > 0.0 {
            long_levels.push(TopLiquidation {
                price: heatmap.prices[i],
                value,
            });
        }
    }

    for (i, &value) in heatmap.short.iter().enumerate() {
        if value > 0.0 {
            short_levels.push(TopLiquidation {
                price: heatmap.prices[i],
                value,
            });
        }
    }

    // 分别按 value 降序排序
    long_levels.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
    short_levels.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));

    long_levels.truncate(limit);
    short_levels.truncate(limit);

    Ok(Json(ApiResponse::success(TopLiquidationsResponse {
        symbol,
        last_price: current_price,
        long: long_levels,
        short: short_levels,
    })))
}

/// 获取杠杆分布统计
#[derive(Serialize)]
struct LeverageStats {
    symbol: String,
    #[serde(rename = "leverageTiers")]
    leverage_tiers: Vec<u32>,
    description: String,
}

async fn get_leverage_stats(
    State(_state): State<Arc<AppState>>,
    Query(params): Query<HeatmapQuery>,
) -> Json<ApiResponse<LeverageStats>> {
    let symbol = params.symbol.unwrap_or_else(|| "BTCUSDT".to_string());

    // 使用固定杠杆档位
    Json(ApiResponse::success(LeverageStats {
        symbol,
        leverage_tiers: crate::liquidation::LEVERAGE_TIERS.to_vec(),
        description: "Fixed leverage tiers: 10x, 25x, 50x, 100x".to_string(),
    }))
}

/// 获取最近的爆仓记录
#[derive(Serialize)]
struct ForceOrderResponse {
    symbol: String,
    orders: Vec<ForceOrderItem>,
}

#[derive(Serialize)]
struct ForceOrderItem {
    side: String,
    price: f64,
    quantity: f64,
    #[serde(rename = "quoteQty")]
    quote_qty: f64,
    #[serde(rename = "marketPrice")]
    market_price: f64,
    #[serde(rename = "estimatedLeverage")]
    estimated_leverage: u32,
    timestamp: i64,
}

#[derive(Debug, Deserialize)]
pub struct ForceOrderQuery {
    pub symbol: Option<String>,
    pub limit: Option<u32>,
}

async fn get_force_orders(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ForceOrderQuery>,
) -> Json<ApiResponse<ForceOrderResponse>> {
    let symbol = params.symbol.unwrap_or_else(|| "BTCUSDT".to_string());
    let limit = params.limit.unwrap_or(50).min(100);

    let orders = match state.storage.get_recent_force_orders(&symbol, limit) {
        Ok(orders) => orders,
        Err(e) => {
            tracing::error!("Failed to get force orders: {}", e);
            return Json(ApiResponse::error(&e.to_string()));
        }
    };

    let items: Vec<ForceOrderItem> = orders
        .into_iter()
        .map(|o| ForceOrderItem {
            side: o.side,
            price: o.price,
            quantity: o.quantity,
            quote_qty: o.quote_qty,
            market_price: o.market_price,
            estimated_leverage: o.estimated_leverage,
            timestamp: o.timestamp,
        })
        .collect();

    Json(ApiResponse::success(ForceOrderResponse {
        symbol,
        orders: items,
    }))
}

/// 获取收集器统计
#[derive(Serialize)]
struct CollectorStats {
    symbol: String,
    #[serde(rename = "totalOrders")]
    total_orders: u32,
    #[serde(rename = "learnedDistribution")]
    learned_distribution: std::collections::HashMap<String, f64>,
    #[serde(rename = "useDynamic")]
    use_dynamic: bool,
}

async fn get_collector_stats(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HeatmapQuery>,
) -> Json<ApiResponse<CollectorStats>> {
    let symbol = params.symbol.unwrap_or_else(|| "BTCUSDT".to_string());

    let total_orders = state.storage.get_force_order_count(&symbol).unwrap_or(0);

    let learned_dist = state
        .storage
        .get_leverage_distribution(&symbol, 7)
        .unwrap_or_default();

    let distribution: std::collections::HashMap<String, f64> = learned_dist
        .into_iter()
        .map(|(k, v)| (format!("{}x", k), v))
        .collect();

    Json(ApiResponse::success(CollectorStats {
        symbol,
        total_orders,
        learned_distribution: distribution,
        use_dynamic: state.config.leverage.use_dynamic,
    }))
}

/// AggTrades 统计
#[derive(Serialize)]
struct AggTradesStats {
    symbol: String,
    #[serde(rename = "totalTrades")]
    total_trades: u64,
    #[serde(rename = "oldestTimestamp")]
    oldest_timestamp: Option<i64>,
    #[serde(rename = "dataHours")]
    data_hours: f64,
}

async fn get_agg_trades_stats(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HeatmapQuery>,
) -> Json<ApiResponse<AggTradesStats>> {
    let symbol = params.symbol.unwrap_or_else(|| "BTCUSDT".to_string());

    let total_trades = state.storage.get_agg_trades_count(&symbol).unwrap_or(0);
    let oldest_timestamp = state.storage.get_agg_trades_min_time(&symbol).unwrap_or(None);

    let data_hours = if let Some(oldest) = oldest_timestamp {
        let now = chrono::Utc::now().timestamp_millis();
        (now - oldest) as f64 / (1000.0 * 60.0 * 60.0)
    } else {
        0.0
    };

    Json(ApiResponse::success(AggTradesStats {
        symbol,
        total_trades,
        oldest_timestamp,
        data_hours,
    }))
}

/// 健康检查
async fn health_check() -> &'static str {
    "OK"
}
