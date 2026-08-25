//! wick-sr-detector 主程序
//!
// 流程:
//! 1. 启动时拉 LOOKBACK_CANDLES 根历史 K 线
//! 2. 检测 wick SR zones
//! 3. WS 实时接收 K 线更新,每根 K close 后再检测一次
//! 4. 新触发的 wick SR 通过钉钉/Telegram 报警

mod binance;
mod detector;
mod notification;
mod types;

use binance::BinanceConfig;
use detector::{detect_wick_sr, DetectOptions};
use notification::{broadcast, NotifyConfig};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let binance_config = BinanceConfig::from_env()?;
    let notify_config = NotifyConfig::from_env();
    let lookback = std::env::var("LOOKBACK_CANDLES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let cooldown_min = std::env::var("ALERT_COOLDOWN_MIN")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(15);
    let detect_options = DetectOptions {
        wick_ratio: std::env::var("WICK_RATIO")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.4),
        reversal_lookback: std::env::var("REVERSAL_LOOKBACK")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10),
    };
    let fvg_min_gap_percent = std::env::var("FVG_MIN_GAP_PERCENT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.01);

    info!(
        "starting wick-sr-detector symbol={} timeframe={} lookback={}",
        binance_config.symbol, binance_config.timeframe, lookback
    );

    // 拉历史 K 线
    let candles = Arc::new(Mutex::new(Vec::<types::Candle>::new()));
    let historical = binance::fetch_klines(&binance_config, lookback).await?;
    info!("loaded {} historical klines", historical.len());
    {
        let mut c = candles.lock().await;
        *c = historical;
    }

    // 初始检测 + 报警
    let reported: Arc<Mutex<HashSet<(i64, String)>>> = Arc::new(Mutex::new(HashSet::new()));
    {
        let c = candles.lock().await;
        let signals = detect_wick_sr(&c, &[], &detect_options);
        info!("initial detection: {} wick zones", signals.len());
    }

    // 启动时如果配置了 DINGTALK_WEBHOOK,发个启动通知
    if notify_config.dingtalk_webhook.is_some() {
        let _ = broadcast(
            &notify_config,
            "wick-sr-detector 启动",
            &format!(
                "### 🚀 wick-sr-detector 已启动\n\n- **监控**: {} @ {}\n- **回溯**: {} 根 K\n- **Wick 阈值**: {}",
                binance_config.symbol, binance_config.timeframe, lookback, detect_options.wick_ratio
            ),
        ).await;
    }

    // WS 实时 K 线
    let candles_clone = candles.clone();
    let reported_clone = reported.clone();
    let notify_clone = notify_config.clone();
    let detect_options_clone = detect_options.clone();
    let symbol = binance_config.symbol.clone();

    binance::stream_klines(&binance_config, move |candle| {
        let candles = candles_clone.clone();
        let reported = reported_clone.clone();
        let notify = notify_clone.clone();
        let opts = detect_options_clone.clone();
        let symbol = symbol.clone();
        async move {
            // 更新最后一根 K(收盘就 append,进行中就 update 最后一根)
            let is_closed = {
                let mut c = candles.lock().await;
                if let Some(last) = c.last_mut() {
                    if last.time == candle.time {
                        *last = candle.clone();
                        true   // 替换最后一根(可能还在形成)
                    } else {
                        c.push(candle.clone());
                        false  // 新 K,可能没收盘
                    }
                } else {
                    c.push(candle.clone());
                    false
                }
            };

            // 简化:每根 K 到达都检测一次(不分 close)
            let c_snapshot = candles.lock().await.clone();
            let signals = detect_wick_sr(&c_snapshot, &[], &opts);

            // 方向过滤:long 趋势只报 S(支撑),short 趋势只报 R(阻力)
            // - 最近 FVG 看涨 → long → true
            // - 最近 FVG 看跌 → short → false
            // - 无 FVG → None → 不限
            let long_only = match detector::latest_fvg_direction(&c_snapshot, fvg_min_gap_percent) {
                Some(true) => true,
                Some(false) => false,
                None => true,
            };
            let want_bullish = long_only;  // long → 只要 S(bullish)
            let want_bearish = !long_only; // short → 只要 R(bearish)

            // 检测新触发的(time + side 没报过)
            let mut reported_lock = reported.lock().await;
            for s in signals {
                // 方向过滤
                let side_is_bullish = s.side == "bullish";
                if (side_is_bullish && !want_bullish) || (!side_is_bullish && !want_bearish) {
                    info!("filtered by direction: {} (long_only={})", s.side, long_only);
                    continue;
                }
                let key = (s.time, s.side.clone());
                if reported_lock.contains(&key) {
                    continue;
                }
                // 冷却:同一根 K 同侧已报过 → 跳过
                reported_lock.insert(key);

                let arrow = if s.side == "bullish" { "↑" } else { "↓" };
                let side_label = if s.side == "bullish" { "支撑 S" } else { "阻力 R" };
                // 反转 wick 单独标注
                let reversal_tag = if s.reversal { " 🔄反转" } else { "" };
                let title = format!("{arrow} wick {} ({} tier={}){}", symbol, side_label, s.tier, reversal_tag);
                let reversal_line = if s.reversal {
                    format!("\n- **反转 wick**: K 线 high/low 是回溯 {} 根的极值(突破前高 / 跌破前低)\n", opts.reversal_lookback)
                } else {
                    String::new()
                };
                let body = format!(
                    "### 📐 wick SR 触发{}\n\n\
- **交易对**: {}\n\
- **方向**: {} ({} )\n\
- **level**: ${:.2}\n\
- **zone**: [${:.2}, ${:.2}]\n\
- **wick 比例**: {:.0}%\n\
- **层级**: {}{}",
                    reversal_tag,
                    symbol,
                    side_label,
                    s.side,
                    s.level,
                    s.zone_low, s.zone_high,
                    s.ratio * 100.0,
                    s.tier,
                    reversal_line
                );
                warn!("new wick SR: {}/{} @ {}", s.side, s.level, s.time);
                if let Err(e) = broadcast(&notify, &title, &body).await {
                    error!("broadcast error: {e}");
                }
            }
        }
    }).await?;

    Ok(())
}
