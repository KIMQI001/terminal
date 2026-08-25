//! wick-sr-detector 主程序
//!
// 流程:
//! 1. 启动时拉 LOOKBACK_CANDLES 根历史 K 线
//! 2. 检测 wick SR zones
//! 3. WS 实时接收 K 线更新,每根 K close 后再检测一次
//! 4. 新触发的 wick SR 通过钉钉/Telegram 报警

mod binance;
mod order;
mod detector;
mod notification;
mod types;

use binance::BinanceConfig;
use detector::{detect_wick_sr, DetectOptions};
use notification::{broadcast, NotifyConfig};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

/// 把 unix epoch 秒格式化成北京时间(UTC+8)"YYYY-MM-DD HH:MM"
fn format_beijing_time(secs: i64) -> String {
    use chrono::TimeZone;
    chrono::FixedOffset::east_opt(8 * 3600)
        .unwrap()
        .timestamp_opt(secs, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "?".to_string())
}

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
    let cooldown_min: u64 = std::env::var("ALERT_COOLDOWN_MIN")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(15);
    let cooldown_secs: i64 = (cooldown_min as i64) * 60;
    let detect_options = DetectOptions {
        wick_ratio: std::env::var("WICK_RATIO")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.4),
        reversal_lookback: std::env::var("REVERSAL_LOOKBACK")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10),
        body_max_usd: std::env::var("WICK_BODY_MAX_USD")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(50.0),
        range_max_usd: std::env::var("WICK_RANGE_MAX_USD")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(250.0),
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
    // reported: HashMap<(candle_time, side), 报警 unix 秒>
    // 同一信号在 cooldown_secs 内不重复报警 + 下单
    let reported: Arc<Mutex<HashMap<(i64, String), i64>>> = Arc::new(Mutex::new(HashMap::new()));
    let signals: Vec<crate::types::WickSR> = {
        let c = candles.lock().await;
        let sigs = detect_wick_sr(&c, &[], &detect_options);
        info!("initial detection: {} wick zones", sigs.len());
        sigs
    };

    // 启动时如果配置了 DINGTALK_WEBHOOK 或 Telegram,发个启动通知(含最近的 wick)
    info!(
        "notify config: dingtalk_webhook={}, telegram_token={}",
        notify_config.dingtalk_webhook.is_some(),
        notify_config.telegram_token.is_some()
    );
    if notify_config.dingtalk_webhook.is_some() || notify_config.telegram_token.is_some() {
        // 找最近一个 wick(按 time 倒序)
        let latest = signals.iter().max_by_key(|s| s.time);
        let wick_section = match latest {
            Some(w) => {
                let arrow = if w.side == "bullish" { "↑" } else { "↓" };
                let side_label = if w.side == "bullish" { "支撑 S" } else { "阻力 R" };
                let reversal_tag = if w.reversal { " 🔄反转" } else { "" };
                let hq_tag = if w.high_quality { " ⭐高等级" } else { "" };
                let time_str = format_beijing_time(w.time);
                format!(
                    "\n\n### 📌 历史最近一个 wick\n\n- **方向**: {} {}{}{}\n- **level**: ${:.2}\n- **zone**: [${:.2}, ${:.2}]\n- **wick 比例**: {:.0}%\n- **层级**: {}\n- **time(北京时间)**: {}",
                    arrow, side_label, reversal_tag, hq_tag,
                    w.level, w.zone_low, w.zone_high,
                    w.ratio * 100.0, w.tier, time_str,
                )
            }
            None => "\n\n### 📌 历史回溯中未发现 wick SR".to_string(),
        };
        let auto_trade = if std::env::var("BINANCE_API_KEY")
            .ok()
            .filter(|s| !s.is_empty())
            .is_some()
        {
            "⚠ 开启(实盘 — BINANCE_API_KEY 已设,会下实单)"
        } else {
            "⛔ 关闭(只报警 — env BINANCE_API_KEY 未设,不下单)"
        };

        // 当前杠杆(从 /fapi/v2/positionRisk 读)— 仅当配了 API key 时查询
        let leverage_section = match (&binance_config.api_key, &binance_config.api_secret) {
            (Some(k), Some(s)) => {
                let base_url = std::env::var("BINANCE_BASE_URL")
                    .unwrap_or_else(|_| "https://fapi.binance.com".to_string());
                match order::get_leverage(k, s, &base_url, &binance_config.symbol).await {
                    Some(lev) => format!(
                        "\n\n### ⚙️ 当前杠杆\n\n- **{}**: **{}x**(来源 positionRisk)\n\n> 未持仓/未设置时 fallback 20x;实际 leverage 取用户在 Binance 面板上的设置,本程序不会修改"
                    , binance_config.symbol, lev),
                    None => "\n\n### ⚙️ 当前杠杆\n\n- 未配 BINANCE_API_KEY/SECRET,无法查询".to_string(),
                }
            }
            _ => "\n\n### ⚙️ 当前杠杆\n\n- 未配 BINANCE_API_KEY/SECRET,无法查询".to_string(),
        };

        // 最近 FVG 方向(用同一组历史 K 算)
        let last_fvg = candles.lock().await.clone();
        let fvg_dir = detector::latest_fvg_direction(&last_fvg, fvg_min_gap_percent);
        let (trend_label, trend_arrow, long_only) = match fvg_dir {
            Some(true)  => ("long (看涨 FVG)",  "↑", true),
            Some(false) => ("short (看跌 FVG)", "↓", false),
            None        => ("无 FVG(不限)",     "—", true),
        };
        let fvg_section = format!(
            "\n\n### 📊 当前 FVG 方向\n\n- **趋势**: {} {}\n- **方向过滤**: {}\n- **FVG 阈值**: {:.2}%",
            trend_arrow, trend_label,
            if long_only { "只报 支撑 S" } else { "只报 阻力 R" },
            fvg_min_gap_percent
        );

        let body = format!(
            "### 🚀 wick-sr-detector 已启动\n\n\
- **监控**: {} @ {}\n\
- **回溯**: {} 根 K\n\
- **Wick 阈值**: {:.2}\n\
- **反转回溯**: {} 根\n\
- **自动下单**: {}{}{}{}",
            binance_config.symbol, binance_config.timeframe,
            lookback, detect_options.wick_ratio,
            detect_options.reversal_lookback, auto_trade, leverage_section, wick_section, fvg_section
        );
        debug!("startup body =\n{}", &body);
        match broadcast(&notify_config, "wick-sr-detector 启动", &body).await {
            Ok(()) => info!("startup notification sent"),
            Err(e) => error!("startup notification failed: {:?}", e),
        }
    }

    // WS 实时 K 线
    let candles_clone = candles.clone();
    let reported_clone = reported.clone();
    let notify_clone = notify_config.clone();
    let detect_options_clone = detect_options.clone();
    let symbol = binance_config.symbol.clone();

    binance::stream_klines(&binance_config, move |candle, is_closed| {
        let candles = candles_clone.clone();
        let reported = reported_clone.clone();
        let notify = notify_clone.clone();
        let opts = detect_options_clone.clone();
        let symbol = symbol.clone();
        async move {
            // 更新最后一根 K(收盘就 append,进行中就 update 最后一根)
            {
                let mut c = candles.lock().await;
                if let Some(last) = c.last_mut() {
                    if last.time == candle.time {
                        *last = candle.clone();
                    } else {
                        c.push(candle.clone());
                    }
                } else {
                    c.push(candle.clone());
                }
            };

            // 只在 K close 时检测 + 报警(wick 必须 close 完才算)
            if !is_closed {
                debug!("candle update time={} (not closed, skip)", candle.time);
                return;
            }

            let c_snapshot = candles.lock().await.clone();
            // 只检测最新一根 K 的 wick(不再扫历史)— 历史 wick 会在前一根 K close 时已经处理过
            let signals = detector::detect_wick_sr_for_last(&c_snapshot, &opts);

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
            info!(
                "tick: candle_time={} bullish_count={} bear_count={} long_only={}",
                candle.time,
                signals.iter().filter(|x| x.side == "bullish").count(),
                signals.iter().filter(|x| x.side == "bearish").count(),
                long_only
            );
            let mut reported_lock = reported.lock().await;
            let now = chrono::Utc::now().timestamp();
            for s in signals {
                // 方向过滤
                let side_is_bullish = s.side == "bullish";
                if !s.reversal && ((side_is_bullish && !want_bullish) || (!side_is_bullish && !want_bearish)) {
                    info!("filtered by direction: {} (long_only={})", s.side, long_only);
                    continue;
                }
                let key = (s.time, s.side.clone());
                // 冷却:距上次报警不足 cooldown_secs → 跳过
                // (cooldown_secs == 0 时 now - last_ts >= 0 恒成立 → 等效关闭冷却)
                match reported_lock.get(&key) {
                    Some(&last_ts) if now - last_ts < cooldown_secs => {
                        debug!(
                            "cooldown: skip alert for key={:?} (last={}, now={}, cooldown_secs={})",
                            key, last_ts, now, cooldown_secs
                        );
                        continue;
                    }
                    _ => {
                        reported_lock.insert(key, now);
                    }
                }

                let arrow = if s.side == "bullish" { "↑" } else { "↓" };
                let side_label = if s.side == "bullish" { "支撑 S" } else { "阻力 R" };
                let reversal_tag = if s.reversal { " 🔄反转" } else { "" };
                let hq_tag = if s.high_quality { " ⭐高等级" } else { "" };
                let title = format!(
                    "{arrow} wick {} ({} tier={}){}{}",
                    symbol, side_label, s.tier, reversal_tag, hq_tag
                );
                let reversal_line = if s.reversal {
                    format!("\n- **反转 wick**: K 线 high/low 是回溯 {} 根的极值(突破前高 / 跌破前低)\n", opts.reversal_lookback)
                } else {
                    String::new()
                };
                let hq_line = if s.high_quality {
                    let candle_type = if s.side == "bullish" { "阴 K" } else { "阳 K" };
                    format!(
                        "\n- **高等级信号**: R 在阳 K / S 在阴 K({})— 收不回原方向 → 推荐 **收盘价**(${:.2})入场\n",
                        candle_type, s.level
                    )
                } else {
                    String::new()
                };
                let body = format!(
                    "### 📐 wick SR 触发{}{}{}\n\n\
- **交易对**: {}\n\
- **方向**: {} ({} )\n\
- **level**: ${:.2}\n\
- **zone**: [${:.2}, ${:.2}]\n\
- **wick 比例**: {:.0}%\n\
- **层级**: {}{}{}",
                    reversal_tag, hq_tag, "".to_string(),
                    symbol,
                    side_label,
                    s.side,
                    s.level,
                    s.zone_low, s.zone_high,
                    s.ratio * 100.0,
                    s.tier,
                    reversal_line,
                    hq_line
                );
                warn!("new wick SR: {}/{} @ {}", s.side, s.level, s.time);
                if let Err(e) = broadcast(&notify, &title, &body).await {
                    error!("broadcast error: {e}");
                }

                // 自动下单(如果配了 API key)— 只高等级 wick 下单
                if s.high_quality && std::env::var("BINANCE_API_KEY").ok().filter(|s| !s.is_empty()).is_some() {
                    let api_key = std::env::var("BINANCE_API_KEY").unwrap_or_default();
                    let api_secret = std::env::var("BINANCE_API_SECRET").unwrap_or_default();
                    let base_url = std::env::var("BINANCE_BASE_URL")
                        .unwrap_or_else(|_| "https://fapi.binance.com".to_string());
                    let position_pct: f64 = std::env::var("POSITION_PCT")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(0.5);
                    let stop_loss_usd: f64 = std::env::var("STOP_LOSS_USD")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(200.0);
                    let take_profit_rr: f64 = std::env::var("TAKE_PROFIT_RR")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(1.0);
                    let _take_profit_usd: f64 = std::env::var("TAKE_PROFIT_USD")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(200.0);
                    let max_orders: u64 = std::env::var("MAX_OPEN_ORDERS")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(2);
                    let leverage_default: u32 = std::env::var("LEVERAGE_DEFAULT")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(100);

                    // 计算入场价:高等级用收盘价,否则用 wick level
                    let entry_price = if s.high_quality {
                        candle.close
                    } else {
                        s.level
                    };

                    // 风控:持仓数上限(查 /fapi/v2/positionRisk)
                    // hedge 模式下 MAX_OPEN_ORDERS 生效;one-way 模式恒 ≤ 1
                    let side_label = if s.side == "bullish" { "支撑 S" } else { "阻力 R" };
                    let pos_count = order::get_position_count(&api_key, &api_secret, &base_url, &symbol).await;
                    if (pos_count as u64) >= max_orders {
                        warn!(
                            "[Order] skip: position count {} >= MAX_OPEN_ORDERS={} (symbol={})",
                            pos_count, max_orders, symbol
                        );
                        let skip_title = "⏸ 仓位已满,跳过下单";
                        let skip_body = format!(
                            "\n\n### ⏸ 仓位已满,跳过本次下单\n\n- **symbol**: {}\n- **当前持仓数**: {}\n- **MAX_OPEN_ORDERS**: {}\n- **本信号**: {} @ ${:.2}\n\n> 计数口径:仅当前监控 symbol 的有持仓方向数(hedge 模式下 LONG/SHORT 独立计算)",
                            symbol, pos_count, max_orders, side_label, s.level
                        );
                        let _ = broadcast(&notify, skip_title, &(body.clone() + &skip_body)).await;
                        continue;
                    }

                    // 止损 = 入场价 ± STOP_LOSS_USD(R 往下,S 往上)
                    let stop_loss = if s.side == "bullish" {
                        entry_price - stop_loss_usd
                    } else {
                        entry_price + stop_loss_usd
                    };

                    // 止盈:R 倍风险(stop 距离 × RR,默认 1.0 = 1:1 对称)
                    let risk = (entry_price - stop_loss).abs();
                    let take_profit = if s.side == "bullish" {
                        entry_price + risk * take_profit_rr
                    } else {
                        entry_price - risk * take_profit_rr
                    };

                    // 计算数量(基于账户余额 * 仓位百分比 * 当前 leverage)
                    let balance = order::get_account_balance(&api_key, &api_secret, &base_url, "USDC").await;
                    // 读当前 leverage(查 /fapi/v2/positionRisk)— 找不到时按 LEVERAGE_DEFAULT fallback(用户设 100x)
                    let leverage = order::get_leverage(&api_key, &api_secret, &base_url, &symbol)
                        .await
                        .unwrap_or(leverage_default);
                    let quantity = order::calculate_quantity(
                        balance, position_pct, leverage, entry_price,
                    );
                    if leverage != leverage_default {
                        info!(
                            "[Order] qty={} (balance={} × pct={} × leverage={} / entry={})",
                            quantity, balance, position_pct, leverage, entry_price
                        );
                    } else {
                        info!(
                            "[Order] qty={} (leverage 查不到,fallback {}: balance={} × pct={} / entry={})",
                            quantity, leverage_default, balance, position_pct, entry_price
                        );
                    }
                    if quantity <= 0.0 {
                        warn!("[Order] quantity=0, skip (balance={})", balance);
                    } else {
                        let side = if s.side == "bullish" { "BUY" } else { "SELL" };
                        let position_side = if s.side == "bullish" { "LONG" } else { "SHORT" };
                        let order_id = format!("wick_{}_{}_{}", s.side, s.time, s.tier);
                        match order::place_order_with_sl_tp(
                            &api_key, &api_secret, &base_url, &symbol,
                            side, position_side,
                            entry_price, stop_loss, take_profit,
                            quantity, &order_id,
                        ).await {
                            Ok(r) => {
                                info!("[Order] placed {} entry={} qty={} SL={} TP={}",
                                    side, r.entry_price, r.quantity, stop_loss, take_profit);
                                let order_body = format!(
                                    "\n\n### 🤖 自动下单\n\n- **方向**: {} {}\n- **入场价**: ${:.2}\n- **数量**: {:.4}\n- **止损**: ${:.2}\n- **止盈**: ${:.2}\n- **订单 ID**: {}",
                                    side, position_side, r.entry_price, r.quantity, stop_loss, take_profit, r.order_id
                                );
                                let _ = broadcast(&notify, "🤖 自动下单成功", &(body.clone() + &order_body)).await;
                            }
                            Err(e) => {
                                error!("[Order] place failed: {:?}", e);
                                let order_body = format!("\n\n### ❌ 下单失败\n\n```\n{}\n```", e);
                                let _ = broadcast(&notify, "❌ 下单失败", &(body.clone() + &order_body)).await;
                            }
                        }
                    }
                }
            }
        }
    }).await?;

    Ok(())
}
