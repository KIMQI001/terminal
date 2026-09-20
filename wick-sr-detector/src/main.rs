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

/// [Protect] 任务计算 TP 距离(USDT):
/// - 用户显式设 PROTECTIVE_TP_USD → 用用户值(覆盖时段逻辑)
/// - 没设 → 按时段动态:
///   - quiet hours(22:45-7:30 跨午夜 或 10:45-20:00):200 USD(信号弱保守)
///   - 正常时段(激活 08:00-10:45 + 纽约 20:00-22:30 北京):400 USD(1:4)
fn protective_tp_usd_dynamic(user_override: Option<f64>) -> f64 {
    if let Some(v) = user_override {
        return v;
    }
    let now_beijing = chrono::Utc::now() + chrono::Duration::hours(8);
    let current_min_q: u32 = now_beijing.format("%H").to_string().parse::<u32>().unwrap_or(0) * 60
        + now_beijing.format("%M").to_string().parse::<u32>().unwrap_or(0);
    let quiet1_start: u32 = 22 * 60 + 45;
    let quiet1_end: u32 = 7 * 60 + 30;
    let quiet2_start: u32 = 10 * 60 + 45;
    let quiet2_end: u32 = 20 * 60;
    // quiet1 跨午夜
    let in_q1 = current_min_q >= quiet1_start || current_min_q < quiet1_end;
    let in_q2 = current_min_q >= quiet2_start && current_min_q < quiet2_end;
    if in_q1 || in_q2 { 200.0 } else { 400.0 }
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
    info!(
        "SL/TP defaults: STOP_LOSS_USD={} TAKE_PROFIT_USD={} (SL env var 可覆盖)",
        std::env::var("STOP_LOSS_USD").ok().and_then(|s| s.parse().ok()).unwrap_or(100.0),
        std::env::var("TAKE_PROFIT_USD").ok().and_then(|s| s.parse().ok()).unwrap_or(400.0)
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
    // 跨 K SR 累计序号:(symbol, side) → (last_wick_time, last_tier)
    // 跟前端 rejection.ts 一致 — 同一根 K 多 wick 同 tier,不同 K tier += 1
    let last_wick: Arc<Mutex<HashMap<(String, String), (i64, u32)>>> = Arc::new(Mutex::new(HashMap::new()));
    // 1D 锚点完整数据(OHLC + OC mid + SR + time)— 启动时拉一次,signals 循环里读
    let daily_anchor: Arc<Mutex<Option<detector::DailyAnchorData>>> = Arc::new(Mutex::new(None));
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
        // 顺便 fetch 1D K 算 daily anchor(用于报警显示跟 1D 锚点的关键价位距离)
        // 对齐前端 DailyKPanel.tsx:46 findAnchor:用日 K 数组最后一根 K 的 close 作 current_price
        if let Ok(daily_k) = binance::fetch_daily_klines(&binance_config, 30).await {
            if let Some(current_price) = daily_k.last().map(|c| c.close) {
                if let Some(anchor) = detector::build_daily_anchor(&daily_k, current_price) {
                    *daily_anchor.lock().await = Some(anchor);
                }
            }
        }

        // 每 5 分钟重算一次 daily anchor(锚定 K 跟随 current_price 变)
        let config_for_recompute = binance_config.clone();
        let daily_anchor_for_recompute = daily_anchor.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                if let Ok(daily_k) = binance::fetch_daily_klines(&config_for_recompute, 30).await {
                    if let Some(current_price) = daily_k.last().map(|c| c.close) {
                        if let Some(anchor) = detector::build_daily_anchor(&daily_k, current_price) {
                            debug!("[DailyAnchor] 重算: K={} O={} H={} L={} C={} OC={} R={:?} S={:?}",
                                anchor.time, anchor.open, anchor.high, anchor.low, anchor.close,
                                anchor.oc_mid, anchor.r_level, anchor.s_level);
                            *daily_anchor_for_recompute.lock().await = Some(anchor);
                        }
                    }
                }
            }
        });
        let fvg_info = detector::latest_fvg_direction(&last_fvg, fvg_min_gap_percent, &detect_options, 60);
        let (trend_label, trend_arrow, long_only, fvg_time_str, fvg_gap_str, source_label) = match fvg_info {
            Some((true, time, gap, "FVG+SR 一致 long")) => ("long (FVG+SR 一致)", "↑", true, format_beijing_time(time), format!("${:.2}", gap), "FVG+SR 一致".to_string()),
            Some((false, time, gap, "FVG+SR 一致 short")) => ("short (FVG+SR 一致)", "↓", false, format_beijing_time(time), format!("${:.2}", gap), "FVG+SR 一致".to_string()),
            Some((true, time, gap, "FVG+SR 矛盾(按 FVG long)")) => ("long (FVG+SR 矛盾,按 FVG)", "↑", true, format_beijing_time(time), format!("${:.2}", gap), "FVG+SR 矛盾(按 FVG)".to_string()),
            Some((false, time, gap, "FVG+SR 矛盾(按 FVG short)")) => ("short (FVG+SR 矛盾,按 FVG)", "↓", false, format_beijing_time(time), format!("${:.2}", gap), "FVG+SR 矛盾(按 FVG)".to_string()),
            Some((true, time, _, "SR only long")) => ("long (SR only)", "↑", true, format_beijing_time(time), "(无 FVG, 用 SR)".to_string(), "SR".to_string()),
            Some((false, time, _, "SR only short")) => ("short (SR only)", "↓", false, format_beijing_time(time), "(无 FVG, 用 SR)".to_string(), "SR".to_string()),
            Some((true, time, gap, "FVG only")) => ("long (FVG only)", "↑", true, format_beijing_time(time), format!("${:.2}", gap), "FVG only".to_string()),
            Some((false, time, gap, "FVG only")) => ("short (FVG only)", "↓", false, format_beijing_time(time), format!("${:.2}", gap), "FVG only".to_string()),
            // 兜底:任何未穷举的 (direction, _, _, _) → 默认 long
            Some(_) => ("long (default)", "↑", true, "?".to_string(), "-".to_string(), "unknown".to_string()),
            None => ("无 FVG/SR(不限)", "—", true, "(无)".to_string(), "-".to_string(), "NONE".to_string()),
        };
        let fvg_section = format!(
            "\n\n### 📊 当前 FVG 方向\n\n- **趋势**: {} {}\n- **FVG 时间(北京)**: {}\n- **FVG gap**: {}\n- **判定来源**: {}\n- **方向过滤**: {}\n- **FVG 阈值**: {:.2}%",
            trend_arrow, trend_label, fvg_time_str, fvg_gap_str, source_label,
            if long_only { "只报 支撑 S" } else { "只报 阻力 R" },
            fvg_min_gap_percent
        );

        // SR fallback 信息:启动时总是显示(辅助验证 SR 检测逻辑,不参与实际过滤)
// 实际过滤按 source_label(FVG / SR)决定;SR 信息仅作参考
        let srs = detector::scan_recent_srs(&last_fvg, &detect_options, 60);
        let highest_r = srs.iter()
            .filter(|s| s.side == "bearish")
            .max_by(|a, b| a.zone_high.partial_cmp(&b.zone_high).unwrap_or(std::cmp::Ordering::Equal));
        let lowest_s = srs.iter()
            .filter(|s| s.side == "bullish")
            .min_by(|a, b| a.zone_low.partial_cmp(&b.zone_low).unwrap_or(std::cmp::Ordering::Equal));
        let chosen = match (highest_r, lowest_s) {
            (Some(r), Some(s)) => {
                if r.time > s.time { Some(r) } else { Some(s) }
            }
            (Some(r), None) => Some(r),
            (None, Some(s)) => Some(s),
            _ => None,
        };
        let sr_fallback_section = match chosen {
            Some(sr) => {
                let sr_side = if sr.side == "bullish" { "支撑 S" } else { "阻力 R" };
                let role = if source_label == "SR" { "(实际采用)" } else { "(仅参考)" };
                let reason = if source_label == "SR" {
                    format!("最近 60 根 K 内 {} 时间更新,fallback 实际用这个", sr_side)
                } else {
                    format!("最近 60 根 K 内 {} 时间更新,但 FVG 优先", sr_side)
                };
                format!(
                    "\n\n### 🛡️ SR Fallback {}\n\n- **类型**: {}\n- **zone**: [${:.2}, ${:.2}]\n- **level**: ${:.2}\n- **K 线时间(北京)**: {}\n- **选这个的理由**: {}",
                    role, sr_side, sr.zone_low, sr.zone_high, sr.level,
                    format_beijing_time(sr.time),
                    reason
                )
            }
            None => String::new(),
        };

        // 1D 锚点信息段(OHLC + OC mid + SR levels)
        let anchor_section = if let Some(anchor) = daily_anchor.lock().await.as_ref() {
            let r_line = anchor.r_level.map(|r| format!("\n  - **R level**: ${:.2}", r)).unwrap_or_default();
            let s_line = anchor.s_level.map(|s| format!("\n  - **S level**: ${:.2}", s)).unwrap_or_default();
            format!(
                "\n\n### 📊 1D 锚点(锚定 K {} 北京)\n\n- **O**: ${:.2}\n- **H**: ${:.2}\n- **L**: ${:.2}\n- **C**: ${:.2}\n- **OC mid**: ${:.2}{}{}",
                format_beijing_time(anchor.time),
                anchor.open, anchor.high, anchor.low, anchor.close, anchor.oc_mid,
                r_line, s_line
            )
        } else {
            String::new()
        };

        let body = format!(
            "### 🚀 wick-sr-detector 已启动\n\n\
- **监控**: {} @ {}\n\
- **回溯**: {} 根 K\n\
- **Wick 阈值**: {:.2}\n\
- **反转回溯**: {} 根\n\
- **自动下单**: {}{}{}{}{}{}",
            binance_config.symbol, binance_config.timeframe,
            lookback, detect_options.wick_ratio,
            detect_options.reversal_lookback, auto_trade, leverage_section, wick_section, fvg_section, sr_fallback_section, anchor_section
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
    let last_wick_clone = last_wick.clone();
    let daily_anchor_clone = daily_anchor.clone();
    let notify_clone = notify_config.clone();
    let detect_options_clone = detect_options.clone();
    let symbol = binance_config.symbol.clone();

    // 读 API key / secret / base_url 一次(下方 WS 闭包 + 仓位保护 task 共用)
    let api_key_global = std::env::var("BINANCE_API_KEY").unwrap_or_default();
    let api_secret_global = std::env::var("BINANCE_API_SECRET").unwrap_or_default();
    let base_url_global = std::env::var("BINANCE_BASE_URL")
        .unwrap_or_else(|_| "https://fapi.binance.com".to_string());

    // 后台仓位保护 task:每 30s 检查"有持仓但没 SL/TP Algo"的仓位,自动补上(默认 SL=100/TP=400)
    if !api_key_global.is_empty() && !api_secret_global.is_empty() {
        let protective_stop_usd: f64 = std::env::var("PROTECTIVE_STOP_USD")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(100.0);
        // protective_tp_usd:用户没设 PROTECTIVE_TP_USD 时,按 quiet hours 动态决定
        //   - quiet hours:200 USD(跟主下单路径一致)
        //   - 正常时段:400 USD(1:4)
        // 用户显式设 PROTECTIVE_TP_USD → 用固定值(覆盖时段逻辑)
        let protective_tp_usd_user_override: Option<f64> = std::env::var("PROTECTIVE_TP_USD")
            .ok().and_then(|s| s.parse().ok());
        // quiet hours 配置(跟主路径一致)
        let quiet1_start: u32 = std::env::var("QUIET_HOURS_1_START_MIN")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(22 * 60 + 45);
        let quiet1_end: u32 = std::env::var("QUIET_HOURS_1_END_MIN")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(7 * 60 + 30);
        let quiet2_start: u32 = std::env::var("QUIET_HOURS_2_START_MIN")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(10 * 60 + 45);
        let quiet2_end: u32 = std::env::var("QUIET_HOURS_2_END_MIN")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(20 * 60);
        let api_key_protect = api_key_global.clone();
        let api_secret_protect = api_secret_global.clone();
        let base_url_protect = base_url_global.clone();
        let notify_protect = notify_clone.clone();
        let symbol_for_cache = symbol.clone();
        tokio::spawn(async move {
            let symbol_for_cache = symbol_for_cache.clone();
            let mut rounds: u32 = 0;
            // 本地 cache:60s 内刚补过的 (symbol, position_side, type) — 防止 Algo 单 30s 后
            // 查不到(交易所异步/用户其他脚本清掉)时反复补
            let mut recently_attempted: std::collections::HashMap<
                (String, String, &'static str),
                std::time::Instant,
            > = std::collections::HashMap::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                rounds += 1;
                // 清理 60s 前的 cache 项
                let now_inst = std::time::Instant::now();
                recently_attempted.retain(|_, t| now_inst.duration_since(*t).as_secs() < 60);
                match order::ensure_protective_orders(
                    &api_key_protect,
                    &api_secret_protect,
                    &base_url_protect,
                    protective_stop_usd,
                    // 每次循环重算 quiet hours,决定 TP 距离
                    // 用户显式设 PROTECTIVE_TP_USD → 用用户值;否则按时段动态
                    protective_tp_usd_dynamic(protective_tp_usd_user_override),
                ).await {
                    Ok(0) => {
                        if rounds % 30 == 0 {
                            info!("[Protect] task alive, 30 rounds (15 min) all positions already protected");
                        }
                    }
                    Ok(n) => {
                        // 标记"刚补过",60s 内不重试同 (symbol, position_side, type)
                        let key_sl = (
                            symbol_for_cache.clone(),
                            "LONG".to_string(),
                            "STOP_MARKET",
                        );
                        let key_tp = (
                            symbol_for_cache.clone(),
                            "LONG".to_string(),
                            "TAKE_PROFIT_MARKET",
                        );
                        recently_attempted.insert(key_sl, std::time::Instant::now());
                        recently_attempted.insert(key_tp, std::time::Instant::now());
                        let tp_actual = protective_tp_usd_dynamic(protective_tp_usd_user_override);
                        warn!("[Protect] 给 {} 个仓位补了 SL/TP(SL={} USD, TP={} USD;TP 按 quiet hours={})",
                            n, protective_stop_usd, tp_actual, tp_actual == 200.0);
                        let body = format!(
                            "\n\n### 🛡️ 仓位保护\n\n- **补单数量**: {}\n- **止损距离**: ${}\n- **止盈距离**: ${}\n\n> 检测到仓位但缺 SL/TP,自动补上(防止裸奔)。60s 内同 (symbol, side, type) 不重试。quiet hours TP 自动 200,正常时段 400",
                            n, protective_stop_usd, tp_actual
                        );
                        let _ = broadcast(&notify_protect, "🛡️ 仓位 SL/TP 已补", &body).await;
                    }
                    Err(e) => warn!("[Protect] failed: {:?}", e),
                }
            }
        });

        // 孤儿 Algo 单清理 v2:用 Binance createTime(真实时间戳)判定 age,
        // 阈值 45 分钟(足够保守,给 Binance 异步更新留充足时间)。
        // - 不依赖本程序 round 计数,程序重启/精度漂移都不影响
        // - 主单刚成交时 positionAmt 异步更新(几秒~几十秒延迟),可能瞬时为 0
        //   但 Algo 单 createTime 是真实时间,不会跟 positionAmt 同步延迟
        // - age ≥ 45 min 才清,加上 45 min 时间窗极不可能误清
        // - 配合 ensure_protective_orders 兜底:即使误清,30s 内补回
        const ORPHAN_MIN_AGE_MS: i64 = 45 * 60 * 1000; // 45 分钟
        let api_key_orphan = api_key_global.clone();
        let api_secret_orphan = api_secret_global.clone();
        let base_url_orphan = base_url_global.clone();
        let symbol_orphan = symbol.clone();
        let notify_orphan = notify_clone.clone();
        tokio::spawn(async move {
            let mut rounds: u32 = 0;
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                rounds += 1;
                // 1) 查 positionAmt
                let pos_amt = match order::get_position_amount(
                    &api_key_orphan, &api_secret_orphan, &base_url_orphan, &symbol_orphan,
                ).await {
                    Some(a) => a,
                    None => {
                        if rounds % 30 == 0 {
                            info!("[Orphan] task alive, {} rounds, API failed last round", rounds);
                        }
                        continue;
                    }
                };
                // 2) 查所有 Algo 单(含 createTime)
                let algos_now = match order::list_open_algo_orders(
                    &api_key_orphan, &api_secret_orphan, &base_url_orphan,
                ).await {
                    Ok(a) => a,
                    Err(e) => {
                        warn!("[Orphan] list failed: {:?}", e);
                        continue;
                    }
                };
                // 3) 仅当 positionAmt == 0 时考虑清理
                if pos_amt.abs() > 0.0001 {
                    if rounds % 30 == 0 {
                        info!("[Orphan] task alive, {} rounds, position={} (protected)", rounds, pos_amt);
                    }
                    continue;
                }
                // 4) 用 Binance createTime 算 age(now_ms - create_time_ms ≥ 45 min 才清)
                let now_ms = chrono::Utc::now().timestamp_millis();
                let mut to_cancel: Vec<(u64, String, i64)> = Vec::new(); // (algo_id, clientAlgoId, age_secs)
                for algo in &algos_now {
                    if algo.create_time_ms <= 0 {
                        // 没拿到 createTime,跳过(保险)
                        continue;
                    }
                    let age_ms = now_ms.saturating_sub(algo.create_time_ms);
                    if age_ms >= ORPHAN_MIN_AGE_MS {
                        to_cancel.push((algo.algo_id, algo.client_algo_id.clone(), age_ms / 1000));
                    }
                }
                if to_cancel.is_empty() {
                    if rounds % 30 == 0 {
                        info!("[Orphan] task alive, {} rounds, {} algos, all under 45 min age", rounds, algos_now.len());
                    }
                    continue;
                }
                // 5) 清理
                let mut cancelled = 0u32;
                let mut cancelled_info: Vec<(u64, i64)> = Vec::new();
                for (algo_id, _client_id, age_secs) in &to_cancel {
                    match order::cancel_single_algo(
                        &api_key_orphan, &api_secret_orphan, &base_url_orphan,
                        &symbol_orphan, *algo_id,
                    ).await {
                        Ok(true) => {
                            cancelled += 1;
                            cancelled_info.push((*algo_id, *age_secs));
                            debug!("[Orphan] cancelled algoId={} age={}s", algo_id, age_secs);
                        }
                        Ok(false) => warn!("[Orphan] cancel algoId={} returned non-ok code", algo_id),
                        Err(e) => warn!("[Orphan] cancel algoId={} failed: {:?}", algo_id, e),
                    }
                }
                if cancelled > 0 {
                    warn!(
                        "[Orphan] 取消了 {} 个孤儿 Algo ({} 已持仓 0 且 age ≥ 45 min),algos={:?}",
                        cancelled, symbol_orphan, cancelled_info
                    );
                    let body = format!(
                        "\n\n### 🧹 孤儿 Algo 清理\n\n- **取消数量**: {}\n- **algo_id (age)**: {:?}\n\n> 用 Binance createTime 判定 age ≥ 45 分钟;positionAmt=0;确认为真孤儿。即便误清,保护 task 30s 内补回",
                        cancelled, cancelled_info
                    );
                    let _ = broadcast(&notify_orphan, "🧹 孤儿 Algo 已清理", &body).await;
                }
            }
        });
    }

    // 给 stream_klines 闭包一个独立的 binance_config 副本(便于 8:00 force 重算 daily_anchor)
    let binance_config_for_closure = binance_config.clone();
    binance::stream_klines(&binance_config, move |candle, is_closed| {
        let candles = candles_clone.clone();
        let reported = reported_clone.clone();
        let last_wick = last_wick_clone.clone();
        let daily_anchor = daily_anchor_clone.clone();
        let notify = notify_clone.clone();
        let opts = detect_options_clone.clone();
        let symbol = symbol.clone();
        let binance_config = binance_config_for_closure.clone();
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

            // 8:00 北京强制重算 daily_anchor:日 K 刚收盘,新 OHLC 必须立刻生效
            // 不等 5 分钟定时器(可能错过 8:00-8:14 窗口的前几根 K)
            // current_min_q 在下面会算,这里先粗略算一下当前北京分钟
            let now_beijing_force = chrono::Utc::now() + chrono::Duration::hours(8);
            let force_refresh_hour: u32 = now_beijing_force.format("%H").to_string().parse::<u32>().unwrap_or(99);
            let force_refresh_min: u32 = now_beijing_force.format("%M").to_string().parse::<u32>().unwrap_or(99);
            // 8:00-8:14 北京(或 0:00-0:14 UTC)+ K 刚刚收盘(在 1 分钟内)→ 立即重算
            if (force_refresh_hour == 0 || force_refresh_hour == 8)
                && force_refresh_min < 15
                && (candle.time - chrono::Utc::now().timestamp()).abs() < 90
            {
                if let Ok(daily_k) = binance::fetch_daily_klines(&binance_config, 30).await {
                    if let Some(current_price) = daily_k.last().map(|c| c.close) {
                        if let Some(anchor) = detector::build_daily_anchor(&daily_k, current_price) {
                            info!("[DailyAnchor] 8:00 北京 force 重算: K={} O={} H={} L={} C={} OC={} R={:?} S={:?}",
                                anchor.time, anchor.open, anchor.high, anchor.low, anchor.close,
                                anchor.oc_mid, anchor.r_level, anchor.s_level);
                            *daily_anchor.lock().await = Some(anchor);
                        }
                    }
                }
            }

            let c_snapshot = candles.lock().await.clone();
            // 只检测最新一根 K 的 wick(不再扫历史)— 历史 wick 会在前一根 K close 时已经处理过
            let signals = detector::detect_wick_sr_for_last(&c_snapshot, &opts);
            // 双 wick 信号检测:连续 2 根 K 同侧 wick zone 重叠
            // 返回 HashSet<side>:"bullish" 表示当前 K 的 S 跟上一根 K 的 S zone 重叠
            let double_wick_sides = detector::detect_double_wick_last(&c_snapshot, &opts);

            // 方向过滤:long 趋势只报 S(支撑),short 趋势只报 R(阻力)
            // - 最近 FVG 看涨 → long → true
            // - 最近 FVG 看跌 → short → false
            // - 无 FVG → None → 不限(默认 long)
            let fvg_info = detector::latest_fvg_direction(&c_snapshot, fvg_min_gap_percent, &opts, 60);
            let (long_only, fvg_time_str, fvg_gap_str) = match fvg_info {
                Some((true, time, gap, "FVG+SR 一致 long")) => (true, format_beijing_time(time), format!("${:.2}", gap)),
                Some((false, time, gap, "FVG+SR 一致 short")) => (false, format_beijing_time(time), format!("${:.2}", gap)),
                Some((true, time, gap, "FVG+SR 矛盾(按 FVG long)")) => (true, format_beijing_time(time), format!("${:.2}(矛盾)", gap)),
                Some((false, time, gap, "FVG+SR 矛盾(按 FVG short)")) => (false, format_beijing_time(time), format!("${:.2}(矛盾)", gap)),
                Some((true, time, _, "SR only long")) => (true, format_beijing_time(time), "(SR)".to_string()),
                Some((false, time, _, "SR only short")) => (false, format_beijing_time(time), "(SR)".to_string()),
                Some((true, time, gap, "FVG only")) => (true, format_beijing_time(time), format!("${:.2}(FVG)", gap)),
                Some((false, time, gap, "FVG only")) => (false, format_beijing_time(time), format!("${:.2}(FVG)", gap)),
                Some(_) => (true, "?".to_string(), "?".to_string()),
                None => (true, "(无)".to_string(), "-".to_string()),
            };
            let want_bullish = long_only;  // long → 只要 S(bullish)
            let want_bearish = !long_only; // short → 只要 R(bearish)

            // 检测新触发的(time + side 没报过)
            info!(
                "tick: candle_time={} bullish_count={} bear_count={} long_only={} fvg_time={} fvg_gap={}",
                candle.time,
                signals.iter().filter(|x| x.side == "bullish").count(),
                signals.iter().filter(|x| x.side == "bearish").count(),
                long_only,
                fvg_time_str,
                fvg_gap_str
            );
            let mut reported_lock = reported.lock().await;
            let now = chrono::Utc::now().timestamp();
            // 计算每个 wick 的 tier — 跨 K 累计序号(对齐前端 rejection.ts)
            // 同一根 K 多个 wick(同 K 上下影)同 tier,不同 K tier += 1
            let mut last_wick_lock = last_wick.lock().await;
            // 读 1D 锚点数据(启动时 fetch 一次,这里只读)
            let anchor_data = (*daily_anchor.lock().await).clone();
            for mut s in signals {
                // 预算 nearest_distance(方向过滤之前算)— 用于判断反向 wick 是否近 1D 关键位
                let mut nearest_distance: f64 = f64::INFINITY;
                if let Some(anchor) = anchor_data.as_ref() {
                    let mut distances: Vec<(&str, f64)> = vec![];
                    distances.push(("1D O", (anchor.open - s.level).abs()));
                    distances.push(("1D H", (anchor.high - s.level).abs()));
                    distances.push(("1D L", (anchor.low - s.level).abs()));
                    distances.push(("1D C", (anchor.close - s.level).abs()));
                    distances.push(("1D OC mid", (anchor.oc_mid - s.level).abs()));
                    if let Some(r) = anchor.r_level {
                        distances.push(("1D R level", (r - s.level).abs()));
                    }
                    if let Some(sl) = anchor.s_level {
                        distances.push(("1D S level", (sl - s.level).abs()));
                    }
                    distances.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                    if let Some((_, dist)) = distances.first() {
                        nearest_distance = *dist;
                    }
                }
                // 方向过滤:反向 wick 但距 1D 关键位 < 85 → 放行报警(不下单,见 will_trade 加 direction_match)
                // 例外:晚上 20:00-21:30 反向 wick 不论距离多远都报(用户原话'晚上 20:00-21:30 普通 wick + 反向 + 距离远(≥ 85)也报')
                let side_is_bullish = s.side == "bullish";
                let now_beijing_filter = chrono::Utc::now() + chrono::Duration::hours(8);
                let current_min_filter: u32 = now_beijing_filter.format("%H").to_string().parse::<u32>().unwrap_or(0) * 60
                    + now_beijing_filter.format("%M").to_string().parse::<u32>().unwrap_or(0);
                let in_2030_window = current_min_filter >= 20 * 60 && current_min_filter < 21 * 60 + 30;
                if !s.reversal && ((side_is_bullish && !want_bullish) || (!side_is_bullish && !want_bearish)) {
                    if nearest_distance < 85.0 {
                        info!("反向 wick {} 距 1D 关键位 {:.0} < 85,放行报警(不下单)", s.side, nearest_distance);
                        // 不 continue,放行
                    } else if in_2030_window {
                        info!("反向 wick {} 距 1D 关键位 {:.0} ≥ 85,但 20:00-21:30 放行(用户策略)", s.side, nearest_distance);
                        // 不 continue,放行
                    } else {
                        info!("filtered by direction: {} (long_only={},距 1D 关键位 {:.0} ≥ 85)", s.side, long_only, nearest_distance);
                        continue;
                    }
                }
                // 计算 tier:跨 K 累计序号
                let side_key = (symbol.clone(), s.side.clone());
                let tier = match last_wick_lock.get(&side_key) {
                    Some((last_time, last_tier)) if *last_time == candle.time => *last_tier, // 同 K 多个 wick 同 tier
                    Some((_last_time, last_tier)) => last_tier + 1, // 不同 K 累计
                    None => 1, // 首次
                };
                s.tier = tier;
                last_wick_lock.insert(side_key, (candle.time, tier));
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
                let is_double_wick = double_wick_sides.contains(&s.side);
let tier_label = format!("{}{}", if s.side == "bullish" { "S" } else { "R" }, s.tier);
                let title = format!(
                    "{arrow} wick {} ({} {}){}{}",
                    symbol, side_label, tier_label, reversal_tag, hq_tag
                );
                let reversal_line = if s.reversal {
                    format!("\n- **反转 wick**: K 线 high/low 是回溯 {} 根的极值(突破前高 / 跌破前低)\n", opts.reversal_lookback)
                } else {
                    String::new()
                };
                // 1D 锚点关键价位距离:列出全部,按距离升序,★ 标记 < 85 USD 关键位
                // nearest_distance 已在方向过滤之前预算(避免重复算),这里只算 is_key / 描述
                let anchor_dist_line = if let Some(anchor) = anchor_data.as_ref() {
                    let mut distances: Vec<(&str, f64, f64)> = vec![];  // (name, key_level, dist)
                    distances.push(("1D O", anchor.open, (anchor.open - s.level).abs()));
                    distances.push(("1D H", anchor.high, (anchor.high - s.level).abs()));
                    distances.push(("1D L", anchor.low, (anchor.low - s.level).abs()));
                    distances.push(("1D C", anchor.close, (anchor.close - s.level).abs()));
                    distances.push(("1D OC mid", anchor.oc_mid, (anchor.oc_mid - s.level).abs()));
                    if let Some(r) = anchor.r_level {
                        distances.push(("1D R level", r, (r - s.level).abs()));
                    }
                    if let Some(sl) = anchor.s_level {
                        distances.push(("1D S level", sl, (sl - s.level).abs()));
                    }
                    distances.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));
                    // 记录最近的(给 will_trade R1 / 方向过滤用)
                    if let Some((_, _, dist)) = distances.first() {
                        nearest_distance = *dist;
                    }
                    let mut lines = vec![format!("\n- **1D 关键价位距离** (wick level = ${:.2}):", s.level)];
                    // 同向/反向判定:
                    //   - bullish(看涨):希望价格向上,关键位 > wick.level → 同向 🟢
                    //   - bearish(看跌):希望价格向下,关键位 < wick.level → 同向 🟢
                    // 反向的关键位**仍显示**(不漏 L 这种例外),但**不标 🟢**(中性)
                    // 用户原话:'反向的不用标记'(指不标颜色,但内容保留)
                    let is_bullish = s.side == "bullish";
                    for (name, key_level, dist) in &distances {
                        let is_key = *dist < 85.0;
                        let arrow = if *key_level > s.level { "↑" } else { "↓" };
                        let same_dir = if is_bullish {
                            *key_level > s.level
                        } else {
                            *key_level < s.level
                        };
                        let prefix = if same_dir { "🟢" } else { "  " };  // 反向不标颜色
                        lines.push(format!(
                            "  - {} {} → ${:.2}({}{:.0} USD{})",
                            prefix, name, key_level, arrow, dist,
                            if is_key { " ★关键位" } else { "" }
                        ));
                    }
                    lines.join("\n")
                } else {
                    String::new()
                };
let hq_line = if s.high_quality {
                    let candle_type = if candle.close > candle.open { "阳 K" } else { "阴 K" };
                    let reason_desc = match s.high_quality_reason.as_str() {
                        "directional" => format!("方向匹配(R 在阳 K / S 在阴 K,收盘价收不回原方向 → {})", candle_type),
                        "doji" => format!("十字星(实体<{:.0} USD + range<{:.0} USD,小实体表犹豫)", opts.body_max_usd, opts.range_max_usd),
                        "both" => format!("方向匹配 + 十字星({} + 实体/range 都小)", candle_type),
                        _ => candle_type.to_string(),
                    };
                    format!(
                        "\n- **高等级信号**: {} → 推荐 **收盘价**(${:.2})入场\n",
                        reason_desc, s.level
                    )
                } else {
                    String::new()
                };
                // 双 wick 信号描述段:跨 2 根 K 同侧 zone 重叠 → 强信号(独立 will_trade 规则)
                let double_wick_line = if is_double_wick {
                    // 算 zone 包含关系(扩展 / 收紧 / 部分重叠)
                    let curr_zone_lo = s.zone_low;
                    let curr_zone_hi = s.zone_high;
                    let prev_zone_lo;
                    let prev_zone_hi;
                    if s.side == "bullish" {
                        // S zone:[low, body_bottom]
                        prev_zone_lo = c_snapshot[c_snapshot.len() - 2].low;
                        prev_zone_hi = (c_snapshot[c_snapshot.len() - 2].open).min(c_snapshot[c_snapshot.len() - 2].close);
                    } else {
                        // R zone:[body_top, high]
                        prev_zone_lo = (c_snapshot[c_snapshot.len() - 2].open).max(c_snapshot[c_snapshot.len() - 2].close);
                        prev_zone_hi = c_snapshot[c_snapshot.len() - 2].high;
                    }
                    let overlap_type = if curr_zone_lo <= prev_zone_lo && curr_zone_hi >= prev_zone_hi {
                        "当前 wick zone 吞掉前一根 K(扩展)"
                    } else if prev_zone_lo <= curr_zone_lo && prev_zone_hi >= curr_zone_hi {
                        "前一根 K 吞掉当前 wick zone(收紧)"
                    } else {
                        "两个 zone 部分重叠(独立测试)"
                    };
                    let side_label = if s.side == "bullish" { "双 S" } else { "双 R" };
                    format!(
                        "\n- **双 wick 信号**: {} 同侧 wick 跨 2 根 K zone 重叠({}) → **触发下单**(独立 will_trade 规则)\n",
                        side_label, overlap_type
                    )
                } else {
                    String::new()
                };
                // 安静时段判定(默认 22:45-隔日 07:30 北京,跨午夜)
// 这里提前算:给 action_line / will_trade / 报警 body 共用
                let quiet_start: u32 = std::env::var("QUIET_HOURS_START_MIN")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(22 * 60 + 45);  // 22:45
                let quiet_end: u32 = std::env::var("QUIET_HOURS_END_MIN")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(8 * 60);   // 08:00
                // current_min 在后面 will_trade 块算,这里复用先算的 now_beijing
                // 由于 current_min 还没算,这里自己算一遍(简单)
                let now_beijing_q = chrono::Utc::now() + chrono::Duration::hours(8);
                let current_min_q: u32 = now_beijing_q.format("%H").to_string().parse::<u32>().unwrap_or(0) * 60
                    + now_beijing_q.format("%M").to_string().parse::<u32>().unwrap_or(0);
                // 跨午夜:start > end 时,in_quiet = (current >= start) || (current < end)
                let in_quiet_v1 = if quiet_start > quiet_end {
                    current_min_q >= quiet_start || current_min_q < quiet_end
                } else {
                    current_min_q >= quiet_start && current_min_q < quiet_end
                };
                // 安静时段 2(默认 10:00-15:00 北京)— 不跨午夜,简单区间
                let quiet2_start: u32 = std::env::var("QUIET_HOURS_2_START_MIN")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(10 * 60 + 45);   // 10:45
                let quiet2_end: u32 = std::env::var("QUIET_HOURS_2_END_MIN")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(20 * 60);   // 20:00
                let in_quiet_v2 = current_min_q >= quiet2_start && current_min_q < quiet2_end;
                // 两个安静时段取并集
                let in_quiet_hours = in_quiet_v1 || in_quiet_v2;
                // 周末流动性差,默认周六全天 + 周日 20:00 前停止下单
                let weekend_resume_min: u32 = std::env::var("WEEKEND_RESUME_MIN")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(20 * 60);  // 周日 20:00
                // chrono `%w`:0=周日, 1=周一, ..., 6=周六
                let weekday_num: u32 = now_beijing_q.format("%w").to_string().parse().unwrap_or(0);
                let is_weekend_block = weekday_num == 6
                    || (weekday_num == 0 && current_min_q < weekend_resume_min);
                // 激活时段(默认 08:00-10:00 北京,每日)— 该时段反转 wick 允许下单
                let active_start: u32 = std::env::var("ACTIVE_HOURS_START_MIN")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(8 * 60);   // 08:00
                let active_end: u32 = std::env::var("ACTIVE_HOURS_END_MIN")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(10 * 60 + 45);  // 10:45
                let in_active_hours = current_min_q >= active_start && current_min_q < active_end;
                // 方向匹配(wick 跟 FVG 方向)— 用于反向 wick 报警但不下单的判定
                let direction_match = (s.side == "bullish" && long_only)
                    || (s.side == "bearish" && !long_only);
                // 8:00-8:14 特殊窗口额外检查:当天 OC 距离 < OC_DISTANCE_MIN_USD 时不开空单
                // 理由:8:00 UTC 日 K 刚收盘,OC 距离小 → 价格易先到 OC mid 反转打止损
                let oc_distance = anchor_data.as_ref()
                    .map(|a| (a.open - a.close).abs())
                    .unwrap_or(0.0);
                let oc_distance_threshold: f64 = std::env::var("OC_DISTANCE_MIN_USD")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(400.0);
                // 8:00-8:14 + 空单 + OC < 阈值 → 不下
                let oc_too_tight_for_short = current_min_q >= 8 * 60
                    && current_min_q < 8 * 60 + 15
                    && s.side == "bearish"
                    && oc_distance > 0.0
                    && oc_distance < oc_distance_threshold;
let action_line = if is_weekend_block {
                    "\n- **动作**: 🚫 周末(周六全天 + 周日 20:00 前)流动性差 → **仅报警,暂停下单**\n".to_string()
                } else if current_min_q == 8 * 60 + 15 {
                    "\n- **动作**: 🔇 8:15 黑名单(日 K 刚开盘,关键位不稳)→ **仅报警,不下单**\n".to_string()
                } else if current_min_q >= 8 * 60 && current_min_q < 8 * 60 + 15 && s.high_quality && direction_match {
                    if oc_too_tight_for_short {
                        format!(
                            "\n- **动作**: 🎯 8 点特殊窗口(8:00-8:14)高等级 + 空单 + OC 距离 {:.0} < {} USD → **仅报警,不开空**\n",
                            oc_distance, oc_distance_threshold
                        ).to_string()
                    } else {
                        "\n- **动作**: 🎯 8 点特殊窗口(8:00-8:14)高等级 → **触发下单**\n".to_string()
                    }
                } else if in_active_hours && s.reversal {
                    "\n- **动作**: 🔁 反转 wick(active hours 08:00-10:45) → **触发下单**\n".to_string()
                } else if in_active_hours {
                    "\n- **动作**: ⏰ 激活时段(08:00-10:45)仅接受反转 wick → **仅报警,不下单**\n".to_string()
                } else if is_double_wick && !s.reversal && direction_match {
                    "\n- **动作**: 🔁 双 wick → **触发下单**\n".to_string()
                } else if s.reversal {
                    "\n- **动作**: 🔁 反转 wick → **仅报警,不下单**(反转 wick 已禁用下单)\n".to_string()
                } else if !direction_match && nearest_distance < 85.0 {
                    format!("\n- **动作**: ⚠️ 反向 wick(近 1D 关键位 {:.0} USD)→ **仅报警,不下单**\n", nearest_distance)
                } else if in_quiet_hours {
                    "\n- **动作**: 🔇 安静时段(22:45-07:00 或 10:45-20:00),仅接受双 wick → **仅报警,不下单**\n".to_string()
                } else if nearest_distance < 85.0 && s.high_quality && direction_match {
                    format!("\n- **动作**: ✅ R1 触发(1D 关键位 {:.0} USD + 高等级 + 方向匹配)→ **触发下单**\n", nearest_distance)
                } else if s.high_quality {
                    "\n- **动作**: ⭐高等级 → **仅报警,不下单**(未近 1D 关键位,R1 不触发)\n".to_string()
                } else {
                    "\n- **动作**: 普通 wick → **仅报警,不下单**\n".to_string()
                };
                let body = format!(
                    "### 📐 wick SR 触发{}{}{}\n\n\
- **交易对**: {}\n\
- **方向**: {}\n\
- **K 线时间(北京)**: {}\n\
- **level**: ${:.2}\n\
- **zone**: [${:.2}, ${:.2}]\n\
- **wick 比例**: {:.0}%\n\
- **层级**: {}\n\
- **FVG 方向**: {} → {}{}{}{}{}{}",
                    reversal_tag, hq_tag, "".to_string(),
                    symbol,
                    side_label,
                    format_beijing_time(s.time),
                    s.level,
                    s.zone_low, s.zone_high,
                    s.ratio * 100.0,
                    tier_label,
                    if long_only { "long (看涨)" } else { "short (看跌)" },
                    if s.reversal {
                        "反转 wick → 不过滤,直接报"
                    } else if (s.side == "bullish" && long_only) || (s.side == "bearish" && !long_only) {
                        "方向匹配 → 报"
                    } else {
                        "方向不匹配 → 本应被过滤(检查代码)"
                    },
                    reversal_line,
                    hq_line,
                    action_line,
                    anchor_dist_line,
                    double_wick_line
                );
                warn!("new wick SR: {}/{} @ {}", s.side, s.level, s.time);
                if let Err(e) = broadcast(&notify, &title, &body).await {
                    error!("broadcast error: {e}");
                }

                // 自动下单(如果配了 API key)— 只高等级 wick 下单
                // 下单条件:
// - 反转 wick:始终下单(无视 FVG 方向,因为反转本身就是趋势反转)
// - 高等级 wick(非反转):仅在 20-24 时段(纽约交易时间)+ 方向同向 才下单
//   (用户规则:纽约时段趋势强,适合同向高等级;其他时段只报警)
                // 20:00 - 22:30 北京(纽约时段早盘 + 末盘前 1.5h)
                // 用分钟数比较支持 22:30 半点小窗口
                let hq_trade_hour_start: u32 = std::env::var("HQ_TRADE_HOUR_START")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(20);
                let hq_trade_hour_end_min: u32 = std::env::var("HQ_TRADE_HOUR_END_MIN")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(22 * 60 + 30);
                let now_beijing = chrono::Utc::now() + chrono::Duration::hours(8);
                // 当前分钟数 = HH*60 + MM(修复前用 `.fold(|acc, n| acc*100 + n)` 错算成 HHMM,
                // 如 20:30 → 2030,跟区间 [start*60, end_min) 比较数学不对位,
                // 导致 20:00-22:30 永远 false,反而 12:00-13:49 错位命中)
                let current_min: u32 = now_beijing.format("%H").to_string().parse::<u32>().unwrap_or(0) * 60
                    + now_beijing.format("%M").to_string().parse::<u32>().unwrap_or(0);
                // 20:00 到 hq_trade_hour_end_min 分钟数(默认 22:30 = 1350 分)
                let in_hq_trade_window = current_min >= hq_trade_hour_start * 60
                    && current_min < hq_trade_hour_end_min;
                let hq_same_direction = s.high_quality && in_hq_trade_window && (
                    (s.side == "bullish" && long_only) ||
                    (s.side == "bearish" && !long_only)
                );
                // 关键位(距离 < 100 USD 视为 1D 大级别关键位)— 也触发下单
                let near_key_level = nearest_distance < 85.0;
                // 双 wick 信号(规则 3):连续 2 根 K 同侧 wick zone 重叠
                // 不依赖 1D 关键位、不依赖 20-22:30 时段
                // (let is_double_wick 已在 alert body 段前面定义)
                // 安静时段(默认 22:45-隔日 07:30 北京,跨午夜):只允许双 wick 下单
                // 避免低活跃时段被假信号(规则 1/2 容易被噪音触发)误下单
                // (let quiet_start / quiet_end / in_quiet_hours 已在 action_line 之前定义)
                // 20-23 高等级同向(规则 2)直接下单,不需要关键位
                // 关键位 + 高等级(规则 1)二选一也下单
                // 双 wick(规则 3)叠加在前两条规则之上,独立触发
                // 安静时段:仅 R3(双 wick)允许下单,R1/R2 失效(避免低活跃误触发)
                // 反转 wick 平时不下单,但 active hours(默认 08:00-10:00)内反转 wick 允许下
                // 反向 wick(方向过滤已放行但不会下单)— direction_match 强制 R1/R3 要求同向
                let direction_match = (s.side == "bullish" && long_only)
                    || (s.side == "bearish" && !long_only);
                let will_trade = if is_weekend_block {
                    // 周末(周六全天 + 周日 20:00 前)流动性差,暂停下单
                    false
                } else if current_min_q == 8 * 60 + 15 {
                    // 8:15 黑名单:日 K 刚开盘(0:00 UTC / 8:00 北京开始),1D K 在重算 OHLC
                    // 关键位不稳,这个时间点处理任何信号都不可靠,什么单都不下
                    false
                } else if current_min_q >= 8 * 60 && current_min_q < 8 * 60 + 15 {
                    // 8:00-8:14 特殊窗口:WS 延迟较短的信号可用
                    // 高等级 + 方向匹配 → 直接下,不看 1D 距离
                    // 但**空单 + 当天 OC < OC_DISTANCE_MIN_USD(默认 400)→ 不下**
                    //   理由:8:00 UTC 日 K 刚收盘,OC 距离小 → 价格易先到 OC mid 反转打止损
                    if oc_too_tight_for_short {
                        false
                    } else {
                        s.high_quality && direction_match
                    }
                } else if in_active_hours {
                    // 激活时段(08:00-10:45,不含 8:00-8:15 特殊窗口)
                    // - 反转 wick 允许下单
                    // - 莲花局(长上影阳 K + 短下影 + wick 距 OC mid 近 + 高质量)也允许下单
                    //   长上影 = 卖方强力抛压,阳 K = 多头收盘,短下影 = 下杀不深
                    //   莲花局时,价格回到 OC mid 附近是强反弹信号
                    if s.reversal {
                        true
                    } else {
                        // 莲花局两种变种(任一满足):
                        //   变种 1(阳 K):close > open + 长上影 + 短下影 + 距 OC mid 近 + 高质量 → 看涨
                        //   变种 2(阴 K):close < open + 短上影 + 长下影 + 距 OC mid 近 + 高质量 → 看跌
                        // 莲花局形态:
                        //   长影线 = 占总范围 ≥ LOTUS_UPPER_WICK_RATIO(默认 0.4)
                        //   短影线 = 占总范围 ≤ LOTUS_LOWER_WICK_RATIO(默认 0.2)
                        let upper_ratio: f64 = std::env::var("LOTUS_UPPER_WICK_RATIO")
                            .ok().and_then(|s| s.parse().ok()).unwrap_or(0.4);
                        let lower_ratio: f64 = std::env::var("LOTUS_LOWER_WICK_RATIO")
                            .ok().and_then(|s| s.parse().ok()).unwrap_or(0.2);
                        let oc_mid_near_usd: f64 = std::env::var("LOTUS_OC_MID_NEAR_USD")
                            .ok().and_then(|s| s.parse().ok()).unwrap_or(50.0);
                        anchor_data.as_ref().map(|a| {
                            let body = (a.close - a.open).abs();
                            let upper_wick = a.high - a.open.max(a.close);
                            let lower_wick = a.open.min(a.close) - a.low;
                            let total_range = a.high - a.low;
                            if total_range <= 0.0 { return false; }
                            let is_bullish_1d = a.close > a.open;
                            let is_bearish_1d = a.close < a.open;
                            let long_upper = upper_wick / total_range >= upper_ratio;
                            let short_upper = upper_wick / total_range <= lower_ratio;
                            let long_lower = lower_wick / total_range >= upper_ratio;
                            let short_lower = lower_wick / total_range <= lower_ratio;
                            let oc_mid_dist = (a.oc_mid - s.level).abs();
                            let near_oc_mid = oc_mid_dist < oc_mid_near_usd;
                            // 变种 1:阳 K + 长上影 + 短下影(看涨莲花)
                            let lotus_bull = is_bullish_1d && long_upper && short_lower;
                            // 变种 2:阴 K + 短上影 + 长下影(看跌莲花)
                            let lotus_bear = is_bearish_1d && short_upper && long_lower;
                            (lotus_bull || lotus_bear) && s.high_quality && near_oc_mid
                        }).unwrap_or(false)
                    }
                } else if s.reversal {
                    // 反转 wick 在其他时段不下单
                    // 例外:晚上 20:00-21:30 反转 wick 也下(用户原话"晚上 20-21:30 也可以做反转")
                    let rev_start: u32 = std::env::var("REVERSAL_HOURS_START")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(20);
                    let rev_end: u32 = std::env::var("REVERSAL_HOURS_END_MIN")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(21 * 60 + 30);
                    let in_reversal_window = current_min_q >= rev_start * 60
                        && current_min_q < rev_end;
                    in_reversal_window
                } else if in_quiet_hours {
                    // 安静时段:仅 R3(双 wick)且同向
                    is_double_wick && direction_match
                } else {
                    // 正常时段:三规则并行
                    (near_key_level && s.high_quality && direction_match)
                    || hq_same_direction
                    || (is_double_wick && direction_match)
                };
                if will_trade && std::env::var("BINANCE_API_KEY").ok().filter(|s| !s.is_empty()).is_some() {
                    let api_key = std::env::var("BINANCE_API_KEY").unwrap_or_default();
                    let api_secret = std::env::var("BINANCE_API_SECRET").unwrap_or_default();
                    let base_url = std::env::var("BINANCE_BASE_URL")
                        .unwrap_or_else(|_| "https://fapi.binance.com".to_string());
                    let position_pct: f64 = std::env::var("POSITION_PCT")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(0.375);
                    let stop_loss_usd: f64 = std::env::var("STOP_LOSS_USD")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(100.0);
                    let take_profit_rr: f64 = std::env::var("TAKE_PROFIT_RR")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(1.0);
                    let _ = take_profit_rr; // 已废弃:TP 固定 ±200 USD,不再依赖 RR
                    let _take_profit_usd: f64 = std::env::var("TAKE_PROFIT_USD")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(200.0);
                    let max_orders: u64 = std::env::var("MAX_OPEN_ORDERS")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(1);
                    let leverage_default: u32 = std::env::var("LEVERAGE_DEFAULT")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(100);

                    // 计算入场价:
// - 反转 wick(突破前 N 根极值):
//   做多 = min(s.level + reversal_offset, candle.close)  ← S 区域中点上方 offset USD 跟 close 取低
//   做空 = max(s.level - reversal_offset, candle.close)  ← R 区域中点下方 offset USD 跟 close 取高
//   做多取较低(挂单更靠反转点 + 更容易 fill),做空取较高
// - 普通 high_quality:用收盘价
// - 普通 wick:用 wick level(中点)
                    let reversal_offset_usd: f64 = std::env::var("REVERSAL_ENTRY_OFFSET_USD")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(200.0);
                    let entry_price = if s.reversal {
                        let candidate = if s.side == "bullish" {
                            (s.level + reversal_offset_usd).min(candle.close)
                        } else {
                            (s.level - reversal_offset_usd).max(candle.close)
                        };
                        info!(
                            "[Reverse wick entry] side={} wick_level={:.2} close={} offset={} → entry={:.2} ({}level{}offset vs close)",
                            s.side, s.level, candle.close, reversal_offset_usd, candidate,
                            if s.side == "bullish" { "wick_level+" } else { "wick_level-" }, 0
                        );
                        candidate
                    } else if s.high_quality {
                        // 高等级信号(影线长,close 不一定最优):比较极值 ± 200 跟 close
                        // S 做多:min(下影最低+200, close) — 极值+200 跟 close 取较低
                        // R 做空:max(上影最高-200, close) — 极值-200 跟 close 取较高
                        // 默认 200 USD 偏移(env 可改)
                        let hq_offset_usd: f64 = std::env::var("HQ_ENTRY_OFFSET_USD")
                            .ok().and_then(|s| s.parse().ok()).unwrap_or(200.0);
                        if s.side == "bullish" {
                            (candle.low + hq_offset_usd).min(candle.close)
                        } else {
                            (candle.high - hq_offset_usd).max(candle.close)
                        }
                    } else {
                        s.level
                    };

                    // 风控:持仓数上限(查 /fapi/v2/positionRisk)
                    // hedge 模式下 MAX_OPEN_ORDERS 生效;one-way 模式恒 ≤ 1
                    // 有仓位 → 任何方向都跳过(不自动反向,避免市价单滑点)
                    let side_label = if s.side == "bullish" { "支撑 S" } else { "阻力 R" };
                    let pos_count = order::get_position_count(&api_key, &api_secret, &base_url, &symbol).await;

                    if (pos_count as u64) >= max_orders {
                        // 已有仓位 + MAX_OPEN_ORDERS 上限已到 → 跳过(不区分同向/反向)
                        warn!(
                            "[Order] skip: position count {} >= MAX_OPEN_ORDERS={} (symbol={})— 已有仓位,新信号不开单",
                            pos_count, max_orders, symbol
                        );
                        let skip_title = "⏸ 已有仓位,跳过新单";
                        let skip_body = format!(
                            "\n\n### ⏸ 已有仓位,跳过本次下单\n\n- **symbol**: {}\n- **当前持仓数**: {} (已有仓位不开新单)\n- **MAX_OPEN_ORDERS**: {}\n- **本信号**: {} @ ${:.2}\n\n> 计数口径:仅当前监控 symbol 的有持仓方向数(hedge 模式 LONG/SHORT 独立)。MAX_OPEN_ORDERS=1 时,有仓位就跳过。新信号跟当前仓位同向或反向都不下,等仓位关闭后下一根 K 信号再入场。",
                            symbol, pos_count, max_orders, side_label, s.level
                        );
                        let _ = broadcast(&notify, skip_title, &(body.clone() + &skip_body)).await;
                        continue;
                    }

                    // 止损:
                    //   - 反转 wick:SL = entry ± distance(distance clamp [REVERSAL_SL_MIN, REVERSAL_SL_MAX])
                    //     distance = |entry - s.level| 即 entry 跟 wick level(R/S 中点)的距离
                    //     然后 clamp 到 [100, 150] USD 区间(防止太紧/太远)
                    //     S 反转做多:SL = entry - clamped_distance
                    //     R 反转做空:SL = entry + clamped_distance
                    //     当 distance ∈ [100, 150] 时 SL = s.level(放在 S/R 上)
                    //   - 普通/高等级/双 wick:固定 entry ± STOP_LOSS_USD USD
                    let reversal_sl_min: f64 = std::env::var("REVERSAL_SL_MIN")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(100.0);
                    let reversal_sl_max: f64 = std::env::var("REVERSAL_SL_MAX")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(150.0);
                    let stop_loss = if s.reversal {
                        // 反转 wick:distance = |entry - s.level|,clamp [100, 150]
                        let raw_distance = (entry_price - s.level).abs();
                        let clamped_distance = raw_distance
                            .max(reversal_sl_min)
                            .min(reversal_sl_max);
                        if s.side == "bullish" {
                            entry_price - clamped_distance
                        } else {
                            entry_price + clamped_distance
                        }
                    } else if s.side == "bullish" {
                        entry_price - stop_loss_usd
                    } else {
                        entry_price + stop_loss_usd
                    };

                    // 止盈:
                    // - 20:00-21:30 反转 wick:TP = 700 USD(用户原话'如果在这个时间段反转,一般是大行情')
                    // - 静默时段(双 wick):TP = 200 USD(信号弱)
                    // - 其他时段:TP = 400 USD(1:4)
                    let is_in_2030_reversal_window = current_min_q >= 20 * 60
                        && current_min_q < 21 * 60 + 30;
                    // 莲花局判定(跟 will_trade 内的 lotus_setup 相同逻辑)
                    // 莲花局 TP 用 700 USD(跟反转 wick 对齐)— 强反转信号
                    let upper_ratio_lotus: f64 = std::env::var("LOTUS_UPPER_WICK_RATIO")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(0.4);
                    let lower_ratio_lotus: f64 = std::env::var("LOTUS_LOWER_WICK_RATIO")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(0.2);
                    let oc_mid_near_lotus: f64 = std::env::var("LOTUS_OC_MID_NEAR_USD")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(50.0);
                    let is_lotus_setup_for_tp = anchor_data.as_ref().map(|a| {
                        let upper_wick_l = a.high - a.open.max(a.close);
                        let lower_wick_l = a.open.min(a.close) - a.low;
                        let total_range_l = a.high - a.low;
                        if total_range_l <= 0.0 { return false; }
                        let is_bullish_1d_l = a.close > a.open;
                        let is_bearish_1d_l = a.close < a.open;
                        let long_upper_l = upper_wick_l / total_range_l >= upper_ratio_lotus;
                        let short_upper_l = upper_wick_l / total_range_l <= lower_ratio_lotus;
                        let long_lower_l = lower_wick_l / total_range_l >= upper_ratio_lotus;
                        let short_lower_l = lower_wick_l / total_range_l <= lower_ratio_lotus;
                        let lotus_bull_l = is_bullish_1d_l && long_upper_l && short_lower_l;
                        let lotus_bear_l = is_bearish_1d_l && short_upper_l && long_lower_l;
                        let near_oc_l = (a.oc_mid - s.level).abs() < oc_mid_near_lotus;
                        (lotus_bull_l || lotus_bear_l) && s.high_quality && near_oc_l
                    }).unwrap_or(false);
                    let take_profit = if (s.reversal && is_in_2030_reversal_window) || is_lotus_setup_for_tp {
                        // 20:00-21:30 反转 wick 或莲花局 → TP = 700 USD
                        // 强信号,1:7 风险回报
                        if s.side == "bullish" {
                            entry_price + 700.0
                        } else {
                            entry_price - 700.0
                        }
                    } else if in_quiet_hours {
                        if s.side == "bullish" {
                            entry_price + 200.0
                        } else {
                            entry_price - 200.0
                        }
                    } else if s.side == "bullish" {
                        entry_price + 400.0
                    } else {
                        entry_price - 400.0
                    };

                    // 计算数量(基于账户余额 * 仓位百分比 * 固定 leverage)
                    // 不用 /fapi/v2/positionRisk 查实际值——直接用 LEVERAGE_DEFAULT
                    // 假设用户在交易所面板已经设了对应杠杆(默认 100x)。
                    // 启动通知里仍然会查一次实际面板 leverage 显示出来供对照。
                    let balance = order::get_account_balance(&api_key, &api_secret, &base_url, "USDC").await;
                    let leverage = leverage_default;
                    let quantity = order::calculate_quantity(
                        balance, position_pct, leverage, entry_price,
                    );
                    info!(
                        "[Order] qty={} (balance={} × pct={} × leverage={} / entry={})",
                        quantity, balance, position_pct, leverage, entry_price
                    );
                    if quantity <= 0.0 {
                        warn!("[Order] quantity=0, skip (balance={})", balance);
                    } else {
                        let side = if s.side == "bullish" { "BUY" } else { "SELL" };
                        let position_side = if s.side == "bullish" { "LONG" } else { "SHORT" };
                        let order_id = format!("wick_{}_{}_{}", s.side, s.time, s.tier);
                        // 任何 wick 触发都市价立即成交(MARKET)按 close 入场
                        // 之前区分反转+高等级 vs 限价,现在简化总是市价
                        // (更"瞬时"反应 — 不等挂单 fill)
                        let use_market = true;
                        info!("[Order] 任何 wick → 市价单立即入场(按 close={})", entry_price);
                        match order::place_order_with_sl_tp(
                            &api_key, &api_secret, &base_url, &symbol,
                            side, position_side,
                            entry_price, stop_loss, take_profit,
                            quantity, &order_id,
                            use_market,
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
