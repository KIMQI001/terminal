use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{Html, Json},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::config::Config;
use crate::kline::{AggTrade, BinanceKlineClient, OpenInterestHist};
use crate::liquidation::{DynamicLeverageWeights, HeatmapData, HeatmapGenerator};
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
        .route("/chart", get(get_chart_page))
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

    // 动态 bucket 大小：当前价格的 0.1%，确保足够的价格精度
    let dynamic_bucket_size = (current_price * 0.001).max(1.0);
    let generator = HeatmapGenerator::new(dynamic_bucket_size);

    // 检查 aggTrades 数据是否足够
    let now = chrono::Utc::now().timestamp_millis();
    let start_time = now - interval_ms;

    // 尝试从真实清算数据获取动态杠杆权重（最近 7 天的数据）
    let dynamic_weights = if state.config.leverage.use_dynamic {
        state.storage.get_leverage_distribution(&symbol, 7)
            .ok()
            .and_then(|dist| DynamicLeverageWeights::from_distribution(dist))
    } else {
        None
    };

    if let Some(ref weights) = dynamic_weights {
        tracing::debug!("Using dynamic leverage weights from {} samples", weights.sample_count());
    }

    let oldest_time = state.storage.get_agg_trades_min_time(&symbol).unwrap_or(None);
    let use_agg_trades = oldest_time.map(|t| t <= start_time).unwrap_or(false);

    // 获取 OI 历史数据（5分钟粒度，覆盖查询时间范围）
    let oi_limit = match interval.as_str() {
        "1w" => 2016,  // 7天 * 24小时 * 12（每小时12个5分钟）
        _ => 288,       // 1天 * 24小时 * 12
    };
    let oi_data = state
        .kline_client
        .get_open_interest_hist(&symbol, "5m", Some(oi_limit), Some(start_time), Some(now))
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("Failed to fetch OI data: {}, using without OI", e);
            vec![]
        });

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

        // 使用 OI 数据来区分开仓/平仓
        let heatmap = if !oi_data.is_empty() {
            tracing::debug!("Using OI data with {} records", oi_data.len());
            generator.generate_from_trades_with_oi(
                &symbol,
                &trades,
                &oi_data,
                current_price,
                now,
                dynamic_weights.as_ref(),
            )
        } else {
            generator.generate_from_trades_with_dynamic_weights(
                &symbol,
                &trades,
                current_price,
                now,
                dynamic_weights.as_ref(),
            )
        };
        (heatmap, format!("aggTrades({}){}",
            trades.len(),
            if !oi_data.is_empty() { format!("+oi({})", oi_data.len()) } else { String::new() }
        ))
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

        let heatmap = generator.generate_from_klines_with_dynamic_weights(
            &symbol,
            &klines,
            current_price,
            now,
            dynamic_weights.as_ref(),
        );
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

    // 动态 bucket 大小：当前价格的 0.1%，确保足够的价格精度
    let dynamic_bucket_size = (current_price * 0.001).max(1.0);
    let generator = HeatmapGenerator::new(dynamic_bucket_size);

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

/// 简易清算图表页面
async fn get_chart_page(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HeatmapQuery>,
) -> Html<String> {
    let symbol = params.symbol.unwrap_or_else(|| "BTCUSDT".to_string());
    let interval = params.interval.unwrap_or_else(|| "1d".to_string());

    // 获取热力图数据
    let interval_ms: i64 = match interval.as_str() {
        "1w" => 7 * 24 * 60 * 60 * 1000,
        _ => 24 * 60 * 60 * 1000,
    };

    let current_price = state.kline_client.get_price(&symbol).await.unwrap_or(0.0);
    // 动态 bucket 大小：当前价格的 0.1%，确保足够的价格精度
    let dynamic_bucket_size = (current_price * 0.001).max(1.0);
    let generator = HeatmapGenerator::new(dynamic_bucket_size);

    let now = chrono::Utc::now().timestamp_millis();
    let start_time = now - interval_ms;
    let oldest_time = state.storage.get_agg_trades_min_time(&symbol).unwrap_or(None);
    let use_agg_trades = oldest_time.map(|t| t <= start_time).unwrap_or(false);

    let (heatmap, data_source) = if use_agg_trades {
        let trades_records = state.storage.get_agg_trades(&symbol, start_time, now).unwrap_or_default();
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
        let h = generator.generate_from_trades(&symbol, &trades, current_price);
        (h, format!("aggTrades ({})", trades.len()))
    } else {
        let kline_count = match interval.as_str() {
            "1w" => 168,
            _ => 24,
        };
        let klines = state.kline_client.get_klines(&symbol, "1h", kline_count).await.unwrap_or_default();
        let h = generator.generate_from_klines(&symbol, &klines, current_price);
        (h, format!("klines ({})", klines.len()))
    };

    // 找到最大值用于归一化
    let max_long = heatmap.long.iter().cloned().fold(0.0_f64, f64::max);
    let max_short = heatmap.short.iter().cloned().fold(0.0_f64, f64::max);
    let max_value = max_long.max(max_short);

    // 计算显示范围（当前价 ±10%）
    let price_min_display = current_price * 0.90;
    let price_max_display = current_price * 1.10;

    // 计算 Top5（在生成柱状图之前）
    let mut long_top: Vec<(f64, f64)> = heatmap.prices.iter().zip(heatmap.long.iter())
        .filter(|(_, v)| **v > 0.0)
        .map(|(p, v)| (*p, *v))
        .collect();
    long_top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    long_top.truncate(5);

    let mut short_top: Vec<(f64, f64)> = heatmap.prices.iter().zip(heatmap.short.iter())
        .filter(|(_, v)| **v > 0.0)
        .map(|(p, v)| (*p, *v))
        .collect();
    short_top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    short_top.truncate(5);

    let long_top_html: String = long_top.iter()
        .map(|(p, v)| format!("<div>{:.0} {:.0}M</div>", p, v / 1_000_000.0))
        .collect::<Vec<_>>()
        .join("");
    let short_top_html: String = short_top.iter()
        .map(|(p, v)| format!("<div>{:.0} {:.0}M</div>", p, v / 1_000_000.0))
        .collect::<Vec<_>>()
        .join("");

    // 生成柱状图 HTML（从高到低）
    let mut bars_html = String::new();
    let bucket_size = dynamic_bucket_size;

    // 收集需要显示的价格索引，然后反转（从高到低）
    let visible_indices: Vec<usize> = heatmap.prices.iter().enumerate()
        .filter(|(_, price)| **price >= price_min_display && **price <= price_max_display)
        .map(|(i, _)| i)
        .collect();

    for i in visible_indices.into_iter().rev() {
        let price = heatmap.prices[i];
        let long_val = heatmap.long[i];
        let short_val = heatmap.short[i];

        let long_pct = if max_value > 0.0 { (long_val / max_value * 100.0).min(100.0) } else { 0.0 };
        let short_pct = if max_value > 0.0 { (short_val / max_value * 100.0).min(100.0) } else { 0.0 };

        let is_current = (price <= current_price) && (price + bucket_size > current_price);
        let bg_style = if is_current { "background: #444;" } else { "" };

        // 高于当前价显示空头清算，低于当前价显示多头清算
        let (bar_class, bar_pct) = if price >= current_price {
            ("short", short_pct)
        } else {
            ("long", long_pct)
        };

        // 在当前价格行右边显示 Top5 表格
        let extra = if is_current {
            format!(r#"<div class="top-inline"><div class="top-box long"><div class="top-title">Long Top5</div>{}</div><div class="top-box short"><div class="top-title">Short Top5</div>{}</div></div>"#, long_top_html, short_top_html)
        } else {
            String::new()
        };

        bars_html.push_str(&format!(
            r#"<div class="row" style="{}"><div class="price">{:.0}</div><div class="bars"><div class="bar {}" style="width:{:.1}%;"></div></div>{}</div>"#,
            bg_style, price, bar_class, bar_pct, extra
        ));
    }

    let long_total: f64 = heatmap.long.iter().sum();
    let short_total: f64 = heatmap.short.iter().sum();

    let html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="120">
    <title>Liquidation Chart - {symbol}</title>
    <style>
        body {{ font-family: monospace; background: #1a1a1a; color: #fff; padding: 8px; margin: 0; }}
        h1 {{ font-size: 13px; margin: 0 0 4px 0; }}
        .info {{ color: #888; font-size: 10px; margin-bottom: 8px; }}
        .chart {{ max-width: 600px; }}
        .row {{ display: flex; align-items: center; height: 8px; }}
        .price {{ width: 50px; text-align: right; padding-right: 4px; font-size: 9px; color: #666; }}
        .bars {{ display: flex; width: 400px; height: 6px; }}
        .bar {{ height: 100%; }}
        .bar.long {{ background: #1e88e5; }}
        .bar.short {{ background: #ff9800; }}
        .legend {{ margin: 8px 0; font-size: 10px; }}
        .legend span {{ margin-right: 12px; }}
        .legend .long-label {{ color: #64b5f6; }}
        .legend .short-label {{ color: #ffcc80; }}
        .stats {{ margin-top: 6px; font-size: 10px; color: #666; }}
        a {{ color: #4fc3f7; }}
        .top-inline {{ display: flex; gap: 15px; margin-left: 15px; }}
        .top-box {{ font-size: 9px; }}
        .top-box.long {{ color: #64b5f6; }}
        .top-box.short {{ color: #ffcc80; }}
        .top-title {{ font-size: 8px; color: #888; margin-bottom: 2px; }}
    </style>
</head>
<body>
    <h1>{symbol} 清算地图 ({interval})</h1>
    <div class="info">
        当前价: {current_price:.2} | 数据源: {data_source} | 自动刷新: 2min
    </div>
    <div class="legend">
        <span class="short-label">◀ 空头清算 (价格上涨触发)</span>
        <span class="long-label">多头清算 (价格下跌触发) ▶</span>
    </div>
    <div class="chart">{bars_html}</div>
    <div class="stats">
        多头: {long_total:.0}M | 空头: {short_total:.0}M |
        <a href="/chart?symbol=BTCUSDT&interval=1d">BTC-1D</a>
        <a href="/chart?symbol=BTCUSDT&interval=1w">BTC-1W</a>
        <a href="/chart?symbol=ETHUSDT&interval=1d">ETH-1D</a>
        <a href="/chart?symbol=ETHUSDT&interval=1w">ETH-1W</a>
    </div>
</body>
</html>"#,
        symbol = symbol,
        interval = interval,
        current_price = current_price,
        data_source = data_source,
        bars_html = bars_html,
        long_total = long_total / 1_000_000.0,
        short_total = short_total / 1_000_000.0,
    );

    Html(html)
}
