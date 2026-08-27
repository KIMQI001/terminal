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
    // 跨 K SR 累计序号:(symbol, side) → (last_wick_time, last_tier)
    // 跟前端 rejection.ts 一致 — 同一根 K 多 wick 同 tier,不同 K tier += 1
    let last_wick: Arc<Mutex<HashMap<(String, String), (i64, u32)>>> = Arc::new(Mutex::new(HashMap::new()));
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
        let fvg_info = detector::latest_fvg_direction(&last_fvg, fvg_min_gap_percent, &detect_options, 60);
        let (trend_label, trend_arrow, long_only, fvg_time_str, fvg_gap_str, source_label) = match fvg_info {
            Some((true, time, gap)) if gap > 0.0 => ("long (看涨 FVG)", "↑", true, format_beijing_time(time), format!("${:.2}", gap), "FVG".to_string()),
            Some((false, time, gap)) if gap > 0.0 => ("short (看跌 FVG)", "↓", false, format_beijing_time(time), format!("${:.2}", gap), "FVG".to_string()),
            Some((true, time, _)) => ("long (SR fallback)", "↑", true, format_beijing_time(time), "(无 FVG, 用 SR)".to_string(), "SR".to_string()),
            Some((false, time, _)) => ("short (SR fallback)", "↓", false, format_beijing_time(time), "(无 FVG, 用 SR)".to_string(), "SR".to_string()),
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

        let body = format!(
            "### 🚀 wick-sr-detector 已启动\n\n\
- **监控**: {} @ {}\n\
- **回溯**: {} 根 K\n\
- **Wick 阈值**: {:.2}\n\
- **反转回溯**: {} 根\n\
- **自动下单**: {}{}{}{}{}",
            binance_config.symbol, binance_config.timeframe,
            lookback, detect_options.wick_ratio,
            detect_options.reversal_lookback, auto_trade, leverage_section, wick_section, fvg_section, sr_fallback_section
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
    let notify_clone = notify_config.clone();
    let detect_options_clone = detect_options.clone();
    let symbol = binance_config.symbol.clone();

    // 读 API key / secret / base_url 一次(下方 WS 闭包 + 仓位保护 task 共用)
    let api_key_global = std::env::var("BINANCE_API_KEY").unwrap_or_default();
    let api_secret_global = std::env::var("BINANCE_API_SECRET").unwrap_or_default();
    let base_url_global = std::env::var("BINANCE_BASE_URL")
        .unwrap_or_else(|_| "https://fapi.binance.com".to_string());

    // 后台仓位保护 task:每 30s 检查"有持仓但没 SL/TP Algo"的仓位,自动补上(对齐 pinbar 默认 200 USD)
    if !api_key_global.is_empty() && !api_secret_global.is_empty() {
        let protective_stop_usd: f64 = std::env::var("PROTECTIVE_STOP_USD")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(200.0);
        let protective_tp_usd: f64 = std::env::var("PROTECTIVE_TP_USD")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(200.0);
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
                    protective_tp_usd,
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
                        warn!("[Protect] 给 {} 个仓位补了 SL/TP(默认 {} USD 距离)", n, protective_stop_usd);
                        let body = format!(
                            "\n\n### 🛡️ 仓位保护\n\n- **补单数量**: {}\n- **止损距离**: ${}\n- **止盈距离**: ${}\n\n> 检测到仓位但缺 SL/TP,自动补上(防止裸奔)。60s 内同 (symbol, side, type) 不重试",
                            n, protective_stop_usd, protective_tp_usd
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

    binance::stream_klines(&binance_config, move |candle, is_closed| {
        let candles = candles_clone.clone();
        let reported = reported_clone.clone();
        let last_wick = last_wick_clone.clone();
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
            // - 无 FVG → None → 不限(默认 long)
            let fvg_info = detector::latest_fvg_direction(&c_snapshot, fvg_min_gap_percent, &opts, 60);
            let (long_only, fvg_time_str, fvg_gap_str) = match fvg_info {
                Some((true, time, gap)) if gap > 0.0 => (true, format_beijing_time(time), format!("${:.2}", gap)),
                Some((false, time, gap)) if gap > 0.0 => (false, format_beijing_time(time), format!("${:.2}", gap)),
                Some((true, time, _)) => (true, format_beijing_time(time), "(SR fallback)".to_string()),
                Some((false, time, _)) => (false, format_beijing_time(time), "(SR fallback)".to_string()),
                None => (true, "(无 FVG/SR)".to_string(), "-".to_string()),
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
            for mut s in signals {
                // 方向过滤
                let side_is_bullish = s.side == "bullish";
                if !s.reversal && ((side_is_bullish && !want_bullish) || (!side_is_bullish && !want_bearish)) {
                    info!("filtered by direction: {} (long_only={})", s.side, long_only);
                    continue;
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
                let action_line = if s.reversal {
                    "\n- **动作**: 🔁 反转 wick → **触发下单**\n"
                } else if s.high_quality {
                    "\n- **动作**: ⭐高等级 → **仅报警,不下单**\n"
                } else {
                    "\n- **动作**: 普通 wick → **仅报警,不下单**\n"
                };
                let body = format!(
                    "### 📐 wick SR 触发{}{}{}\n\n\
- **交易对**: {}\n\
- **方向**: {} ({} {})\n\
- **K 线时间(北京)**: {}\n\
- **level**: ${:.2}\n\
- **zone**: [${:.2}, ${:.2}]\n\
- **wick 比例**: {:.0}%\n\
- **层级**: {}\n\
- **FVG 方向**: {} → {}{}{}",
                    reversal_tag, hq_tag, "".to_string(),
                    symbol,
                    side_label,
                    tier_label,
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
                    action_line
                );
                warn!("new wick SR: {}/{} @ {}", s.side, s.level, s.time);
                if let Err(e) = broadcast(&notify, &title, &body).await {
                    error!("broadcast error: {e}");
                }

                // 自动下单(如果配了 API key)— 只高等级 wick 下单
                if s.reversal && std::env::var("BINANCE_API_KEY").ok().filter(|s| !s.is_empty()).is_some() {
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
                    let side_label = if s.side == "bullish" { "支撑 S" } else { "阻力 R" };
                    let pos_count = order::get_position_count(&api_key, &api_secret, &base_url, &symbol).await;
                    // 检测"反向仓位":有仓位 + 仓位方向跟新信号方向相反
                    // 反向 = 趋势变了 → 市价平仓现有仓位再开新方向(AUTO_REVERSE_POSITION 控制)
                    let new_pos_side = if s.side == "bullish" { "LONG" } else { "SHORT" };
                    let current_positions = order::get_positions_for_reverse(&api_key, &api_secret, &base_url, &symbol).await;
                    let has_reverse_position = current_positions.iter()
                        .any(|p| p.1 == order::opposite(&new_pos_side));

                    let auto_reverse: bool = std::env::var("AUTO_REVERSE_POSITION")
                        .ok().and_then(|s| s.parse().ok()).unwrap_or(true);

                    if (pos_count as u64) >= max_orders {
                        // 已有仓位 + MAX_OPEN_ORDERS 上限已到
                        if has_reverse_position && auto_reverse {
                            // 反向仓位 → 市价平仓现有 + 跳过新方向(下一步发)
                            warn!(
                                "[Reverse] {} 现有仓位方向跟新信号 {} 相反,自动市价平仓并跳过本信号",
                                symbol, new_pos_side
                            );
                            for p in &current_positions {
                                let close_side = if p.1 == "LONG" { "SELL".to_string() } else { "BUY".to_string() };
                                let qty = p.2.abs();
                                if qty < 0.0001 { continue; }
                                match order::place_close_position_market(
                                    &api_key, &api_secret, &base_url,
                                    &symbol, &close_side, &p.1, qty,
                                ).await {
                                    Ok(id) => warn!("[Reverse] {} 平仓单 orderId={} qty={}", symbol, id, qty),
                                    Err(e) => warn!("[Reverse] {} 平仓失败: {}", symbol, e),
                                }
                            }
                            // 等几秒让平仓单成交(Binance 异步)
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            // 不 continue — 继续走流程,正常下新方向单
                            // 平仓后仓位=0,MAX_OPEN_ORDERS 检查通过
                        } else {
                            warn!(
                                "[Order] skip: position count {} >= MAX_OPEN_ORDERS={} (symbol={})— 已有仓位,新信号不开单",
                                pos_count, max_orders, symbol
                            );
                            let skip_title = "⏸ 已有仓位,跳过新单";
                            let skip_body = format!(
                                "\n\n### ⏸ 已有仓位,跳过本次下单\n\n- **symbol**: {}\n- **当前持仓数**: {} (已有仓位不开新单)\n- **MAX_OPEN_ORDERS**: {}\n- **本信号**: {} @ ${:.2}\n\n> 计数口径:仅当前监控 symbol 的有持仓方向数(hedge 模式 LONG/SHORT 独立)。MAX_OPEN_ORDERS=1 时,有仓位就跳过",
                                symbol, pos_count, max_orders, side_label, s.level
                            );
                            let _ = broadcast(&notify, skip_title, &(body.clone() + &skip_body)).await;
                            continue;
                        }
                    }

                    // 止损 = entry ± STOP_LOSS_USD 跟 K 极值取离 entry 较近的那个
//   - S 做多:max(entry - stop_loss, candle.low)— 取较高(离 entry 较近 = 止损小)
                    //   如果 candle.low 比 entry - 200 更接近 entry,SL = candle.low(更紧)
                    //   否则 SL = entry - 200(标准距离)
                    //   同理 R 做空:min(entry + stop_loss, candle.high)
                    let stop_loss = if s.side == "bullish" {
                        (entry_price - stop_loss_usd).max(candle.low)
                    } else {
                        (entry_price + stop_loss_usd).min(candle.high)
                    };

                    // 止盈:R 倍风险(stop 距离 × RR,默认 1.0 = 1:1 对称)
                    let risk = (entry_price - stop_loss).abs();
                    let take_profit = if s.side == "bullish" {
                        entry_price + risk * take_profit_rr
                    } else {
                        entry_price - risk * take_profit_rr
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
                        // 反转 + 高等级:市价立即成交(MARKET)
                        // 普通反转:限价挂单(LIMIT)— entry_price 用极值 ± 200 vs close
                        let use_market = s.reversal && s.high_quality;
                        if use_market {
                            info!("[Order] 反转 + 高等级 → 市价单立即入场(K 形态确认强度,不等挂单成交)");
                        } else {
                            info!("[Order] 普通反转 → 限价单挂单 entry={}", entry_price);
                        }
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
