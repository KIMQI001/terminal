/**
 * HTTP 接口(axum)
 *
 * - GET  /health   健康检查
 * - GET  /status   策略状态
 * - POST /config   配置并启动策略(由 Next.js 代理转发,api_key/secret 在代理里解密后注入)
 * - POST /stop     停止策略(并撤掉自己挂的入场单)
 */

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::detector::compute_frame;
use crate::kline::{default_limit, fetch_klines};
use crate::strategy::Engine;
use crate::types::{StrategyConfig, StrategyStatus};

pub fn router(engine: Arc<Engine>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .route("/frame", get(frame))
        .route("/config", post(config))
        .route("/stop", post(stop))
        .with_state(engine)
}

/// 只算框架(不需要交易所密钥),用于校验 Rust 侧与前端面板是否一致
#[derive(Debug, Deserialize)]
pub struct FrameQuery {
    pub symbol: String,
    #[serde(default = "default_timeframe")]
    pub timeframe: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

fn default_timeframe() -> String {
    "15m".to_string()
}

async fn frame(Query(q): Query<FrameQuery>) -> Json<serde_json::Value> {
    let limit = q.limit.unwrap_or_else(|| default_limit(&q.symbol));
    match fetch_klines(&q.symbol, &q.timeframe, limit).await {
        Ok(candles) => {
            let f = compute_frame(&candles, &q.timeframe);
            match f {
                Some(frame) => {
                    let levels: Vec<serde_json::Value> = frame
                        .all_levels()
                        .iter()
                        .map(|l| {
                            json!({
                                "label": l.label,
                                "price": l.price,
                                "side": l.side,
                                "kind": l.kind,
                                "pivot": l.pivot_label,
                                "covered": l.covered,
                                "covered_at": l.covered_at,
                            })
                        })
                        .collect();
                    Json(json!({
                        "ok": true,
                        "symbol": q.symbol,
                        "timeframe": q.timeframe,
                        "candles": candles.len(),
                        "hh": {"price": frame.hh.price, "time": frame.hh.time, "index": frame.hh_index},
                        "ll": {"price": frame.ll.price, "time": frame.ll.time, "index": frame.ll_index},
                        "leg": {
                            "from_price": frame.leg.from.price,
                            "to_price": frame.leg.to.price,
                            "change": frame.leg.change,
                            "percent": frame.leg.percent,
                            "bars": frame.leg.bars,
                            "duration_sec": frame.leg.duration_sec,
                        },
                        "established": frame.is_established(),
                        "levels": levels,
                    }))
                }
                None => Json(json!({ "ok": false, "error": "数据不足,算不出框架" })),
            }
        }
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "service": "look-left-right" }))
}

async fn status(State(engine): State<Arc<Engine>>) -> Json<StrategyStatus> {
    let rt = engine.rt.lock().await;
    Json(rt.status())
}

async fn config(
    State(engine): State<Arc<Engine>>,
    Json(cfg): Json<StrategyConfig>,
) -> Json<StrategyStatus> {
    engine.configure(cfg).await;
    let rt = engine.rt.lock().await;
    Json(rt.status())
}

/// 停止策略(可选带 reason)
#[derive(Debug, Deserialize, Default)]
pub struct StopRequest {
    #[serde(default)]
    pub reason: Option<String>,
}

async fn stop(
    State(engine): State<Arc<Engine>>,
    body: Option<Json<StopRequest>>,
) -> Json<StrategyStatus> {
    if let Some(Json(req)) = &body {
        if let Some(r) = &req.reason {
            tracing::info!("[API] 收到停止指令: {}", r);
        }
    }
    engine.stop().await;
    let rt = engine.rt.lock().await;
    Json(rt.status())
}
