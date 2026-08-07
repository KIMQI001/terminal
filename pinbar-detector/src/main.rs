//! Pinbar 实时检测服务（命令行版本）
//!
//! 1. 先通过 REST API 获取历史 K 线数据
//! 2. WebSocket 实时更新 K 线
//! 3. 实时检测 Pinbar 信号并输出到终端
//! 4. 检测 15m 倍量报警并发送钉钉通知
//! 5. 自动下单（限价单 + 止损）

mod binance;
mod notification;
mod daily_hl;

use futures_util::{SinkExt, StreamExt};
use pinbar_detector::{detect_fvg, detect_order_blocks, detect_recent_pinbars, Candle, FVG, OrderBlock};
use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::sync::OnceLock;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// 启动时缓存的 Binance config（用于拉日 K）
static OB_CONFIG: OnceLock<binance::BinanceConfig> = OnceLock::new();

/// Binance WebSocket K线地址（USDC 合约）
const BINANCE_WS_URL: &str = "wss://fstream.binance.com/market/ws/btcusdc@kline_15m";

/// Binance REST API 地址（USDC 合约）
const BINANCE_REST_URL: &str = "https://fapi.binance.com";

/// 每个周期返回的最近信号数量
const RECENT_SIGNALS_LIMIT: usize = 5;

/// Swing Point 检测长度(从环境变量读取,默认 20 — 与前端 15m 一致)
fn get_swing_length() -> usize {
    env::var("SWING_LENGTH")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20)
        .clamp(2, 500)
}

/// 固定止盈点数（从环境变量读取，默认300点）
fn get_fixed_profit_points() -> f64 {
    env::var("FIXED_PROFIT_POINTS")
        .unwrap_or_else(|_| "300".to_string())
        .parse::<f64>()
        .unwrap_or(300.0)
}

/// 开仓占账户余额比例 0.0~1.0（从环境变量读取，默认0.3=30%）
fn get_position_pct() -> f64 {
    env::var("POSITION_PCT")
        .unwrap_or_else(|_| "0.3".to_string())
        .parse::<f64>()
        .unwrap_or(0.3)
        .clamp(0.0, 1.0)
}

/// 杠杆倍数（从环境变量读取，默认100x，clamp 到 1~125）
fn get_leverage() -> u32 {
    env::var("LEVERAGE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100)
        .clamp(1, 125)
}

/// 追踪止盈激活点数（从环境变量读取，默认300点）
fn get_trailing_activation_points() -> f64 {
    env::var("TRAILING_ACTIVATION_POINTS")
        .unwrap_or_else(|_| "300".to_string())
        .parse::<f64>()
        .unwrap_or(300.0)
}

/// 回调点数（从环境变量读取，默认100点）
fn get_callback_profit_points() -> f64 {
    env::var("CALLBACK_PROFIT_POINTS")
        .unwrap_or_else(|_| "100".to_string())
        .parse::<f64>()
        .unwrap_or(100.0)
}

/// 保护性止损激活点数（从环境变量读取，默认300点）
fn get_protective_activation_points() -> f64 {
    env::var("PROTECTIVE_ACTIVATION_POINTS")
        .unwrap_or_else(|_| "300".to_string())
        .parse::<f64>()
        .unwrap_or(300.0)
}

/// 保护性止损点数（从环境变量读取，默认100点）
fn get_protective_stop_points() -> f64 {
    env::var("PROTECTIVE_STOP_POINTS")
        .unwrap_or_else(|_| "100".to_string())
        .parse::<f64>()
        .unwrap_or(100.0)
}

/// Swing Point 附近范围
const SWING_RANGE: usize = 5;

/// FVG 最小 Gap 百分比（默认 0.1%，与前端 src/lib/chart/indicators/fvg.ts 保持一致）
const FVG_MIN_GAP_PERCENT: f64 = 0.1;

/// K线数据
#[derive(Debug, Deserialize)]
struct KlineData {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

/// REST API 响应
#[derive(Debug, Deserialize)]
struct KlineResponse {
    #[allow(dead_code)]
    symbol: String,
    #[allow(dead_code)]
    timeframe: String,
    klines: Vec<KlineData>,
}

/// WebSocket 消息（K线更新）
#[derive(Debug, Deserialize)]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    data: Option<WsDataEnvelope>,
}

#[derive(Debug, Deserialize)]
struct WsDataEnvelope {
    data: KlineData,
}

/// Binance WebSocket K线消息（直接格式）
#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct BinanceKlineMsg {
    e: String,        // Event type
    E: i64,           // Event time
    s: String,        // Symbol
    k: Option<BinanceKline>,
}

/// Binance K线数据
#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct BinanceKline {
    t: i64,       // Kline start time (ms)
    T: i64,       // Kline close time (ms)
    s: String,    // Symbol
    i: String,    // Interval
    o: String,    // Open price
    c: String,    // Close price
    h: String,    // High price
    l: String,    // Low price
    v: String,    // Base asset volume
    x: bool,      // Is this kline closed? (关键!)
    q: String,    // Quote asset volume
    n: i64,       // Number of trades
}

/// Binance REST API K线响应格式 (数组)
type BinanceRestKline = Vec<serde_json::Value>;

/// 倍量报警比例（从环境变量读取，默认2.0倍）
fn get_volume_alert_ratio() -> f64 {
    env::var("VOLUME_ALERT_RATIO")
        .unwrap_or_else(|_| "2.0".to_string())
        .parse::<f64>()
        .unwrap_or(2.0)
}

/// 是否启用交易（从环境变量读取，默认true）
fn get_enable_trading() -> bool {
    env::var("ENABLE_TRADING")
        .unwrap_or_else(|_| "true".to_string())
        .parse::<bool>()
        .unwrap_or(true)
}

/// 倍量报警检测
/// 检测条件：
/// 1. 当前成交量 >= 前一根的 N 倍（默认2倍，可配置）
/// 2. 倍量K线往前两根K线与当前K线同色
/// 3. 倍量K线往后两根K线有一根实体小于 100 美元
/// 返回：(倍量位置, 成交量倍数, 满足条件的小K线位置)
fn check_volume_alert(candles: &[Candle]) -> Option<(usize, f64, usize)> {
    if candles.len() < 4 {
        return None;
    }

    let alert_ratio = get_volume_alert_ratio();

    // 从倒数第 2 根开始检查（倒数第 1 根可能还在更新）
    let len = candles.len();
    for i in (2..len - 1).rev() {
        let prev = &candles[i - 1];
        let current = &candles[i];

        // 倍量检测：当前成交量 >= 前一根的 N 倍
        if prev.volume > 0.0 && current.volume >= prev.volume * alert_ratio {
            let ratio = current.volume / prev.volume;

            // 检查前两根K线是否与当前K线同色
            let current_is_bullish = current.close >= current.open;
            let prev1_is_bullish = candles[i - 1].close >= candles[i - 1].open;
            let prev2_is_bullish = candles[i - 2].close >= candles[i - 2].open;
            let same_color_before = current_is_bullish == prev1_is_bullish && current_is_bullish == prev2_is_bullish;

            if !same_color_before {
                continue;
            }

            // 检查后续第一根 K 线实体是否小于 100（立即发，不等第二根）
            let next1_body = (candles[i + 1].close - candles[i + 1].open).abs();

            // 如果第一根小于 100，立即发送报警
            if next1_body < 100.0 {
                let vol_is_bearish = current.close < current.open;
                let direction = if vol_is_bearish { "做多 🐂" } else { "做空 🐻" };
                let entry = candles[i + 1].open;
                let stop = current.low.min(candles[i + 1].low);
                info!("倍量反转: 位置={}, 比例={:.1}x, 小K线位置={}, 实体={:.2}, 方向={}, 入场=${:.2}, 止损=${:.2}",
                    i, ratio, i + 1, next1_body, direction, entry, stop);
                return Some((i, ratio, i + 1));
            }

            // 如果第一根不小于 100，检查第二根
            if i + 2 < len {
                let next2_body = (candles[i + 2].close - candles[i + 2].open).abs();
                if next2_body < 100.0 {
                    let vol_is_bearish = current.close < current.open;
                    let direction = if vol_is_bearish { "做多 🐂" } else { "做空 🐻" };
                    let entry = candles[i + 2].open;
                    let stop = current.low.min(candles[i + 2].low);
                    info!("倍量反转: 位置={}, 比例={:.1}x, 小K线位置={}, 实体={:.2}, 方向={}, 入场=${:.2}, 止损=${:.2}",
                        i, ratio, i + 2, next2_body, direction, entry, stop);
                    return Some((i, ratio, i + 2));
                }
            }
        }
    }

    None
}

/// 格式化倍量报警消息并发送钉钉，同时可选自动下单
async fn send_volume_alert(
    symbol: &str,
    candles: &[Candle],
    vol_index: usize,      // 倍量K线位置
    ratio: f64,
    small_index: usize,    // 小实体K线位置
    binance_config: Option<&crate::binance::BinanceConfig>,
    should_trade: bool,    // 是否实际下单，false=仅报警（启动时）
) {
    let vol_candle = &candles[vol_index];
    let small_candle = &candles[small_index];

    let vol_is_bearish = vol_candle.close < vol_candle.open;
    let vol_direction = if vol_is_bearish { "阴线" } else { "阳线" };
    let vol_emoji = if vol_is_bearish { "🔴" } else { "🟢" };

    let small_direction = if small_candle.close >= small_candle.open { "阳线" } else { "阴线" };
    let small_emoji = if small_candle.close >= small_candle.open { "🟢" } else { "🔴" };

    // 交易方向：倍量阴线→下跌到高潮→应该做多；倍量阳线→上涨到高潮→应该做空
    let (direction, direction_emoji, order_side, position_side) = if vol_is_bearish {
        ("做多", "🐂", "BUY", "LONG")
    } else {
        ("做空", "🐻", "SELL", "SHORT")
    };

    // 入场价格：小实体K线的收盘价，偏离5个点避免现价吃单
    let entry_price = if vol_is_bearish {
        small_candle.close - 5.0  // 做多减5点
    } else {
        small_candle.close + 5.0  // 做空加5点
    };

    // 止损价格：固定200点
    let stop_loss = if vol_is_bearish {
        entry_price - 200.0  // 做多：入场价 - 200点
    } else {
        entry_price + 200.0  // 做空：入场价 + 200点
    };

    // 仅在 should_trade=true 时下单（运行时），启动时不下单
    let mut quantity = 0.0;
    if should_trade {
        if let Some(config) = binance_config {
            // 获取可用余额（USDC）
            match crate::binance::get_balance(config, "USDC").await {
                Ok(balance) => {
                    let position_pct = get_position_pct();
                    let leverage = get_leverage();
                    let use_amount = balance * position_pct;
                    quantity = (use_amount * leverage as f64) / entry_price;
                    let client_order_id_prefix = format!("vol_{}", chrono::Utc::now().timestamp_millis());

                    // 先检查现有仓位
                    let mut has_opposite_position = false;
                    let mut has_same_position = false;
                    match crate::binance::get_positions(config, symbol).await {
                        Ok(positions) => {
                            for pos in positions.iter() {
                                let pos_amt = pos.position_amt.abs();
                                if pos_amt < 0.001 {
                                    continue;
                                }
                                // 如果现有仓位与信号方向相反，标记需要平仓
                                let is_opposite = if position_side == "LONG" && pos.position_side == "SHORT" {
                                    true
                                } else if position_side == "SHORT" && pos.position_side == "LONG" {
                                    true
                                } else {
                                    false
                                };

                                if is_opposite {
                                    has_opposite_position = true;
                                    info!("[反向平仓] {} -> {}", pos.position_side, position_side);
                                    match crate::binance::close_position_market(config, symbol, &pos.position_side, pos_amt).await {
                                        Ok(order_id) => {
                                            info!("反向平仓成功: orderId={}", order_id);
                                        }
                                        Err(e) => {
                                            warn!("反向平仓失败: {}", e);
                                        }
                                    }
                                } else {
                                    // 同向仓位
                                    has_same_position = true;
                                    info!("[同向仓位] {} 已有持仓，跳过开仓", pos.position_side);
                                }
                            }
                        }
                        Err(e) => {
                            warn!("获取持仓失败: {}", e);
                        }
                    }

                    // 只有在没有同向仓位时才取消挂单和下单
                    if !has_same_position {
                        // 取消所有挂单
                        if let Err(e) = crate::binance::cancel_all_orders(config, symbol).await {
                            warn!("取消挂单失败: {}", e);
                        }

                        // 下限价单（入场）- clientOrderId 只允许 [.A-Z:/a-z0-9_-]
                        let order_id = match crate::binance::place_limit_order(
                            config,
                            symbol,
                            order_side,
                            position_side,
                            entry_price,
                            quantity,
                            &format!("{}_entry", client_order_id_prefix),
                        ).await {
                            Ok(id) => {
                                info!("入场单成功: orderId={}", id);
                                Some(id)
                            }
                            Err(e) => {
                                warn!("入场单失败: {}", e);
                                None
                            }
                        };

                        // 下止损单 - clientOrderId 只允许 [.A-Z:/a-z0-9_-]
                        if order_id.is_some() {
                            let stop_side = if order_side == "BUY" { "SELL" } else { "BUY" };
                            let stop_client_id = format!("{}_stop", client_order_id_prefix);
                            match crate::binance::place_stop_loss_order(
                                config,
                                symbol,
                                stop_side,
                                position_side,
                                quantity,
                                stop_loss,
                                &stop_client_id,
                            ).await {
                                Ok(algo_id) => {
                                    info!("止损单成功: algoId={}", algo_id);
                                }
                                Err(e) => {
                                    warn!("止损单失败: {}", e);
                                }
                            }

                            // 下固定止盈单（固定点数保底）
                            let fixed_profit_points = get_fixed_profit_points();
                            let take_profit_price = if order_side == "BUY" {
                                entry_price + fixed_profit_points
                            } else {
                                entry_price - fixed_profit_points
                            };
                            let tp_client_id = format!("{}_tp", client_order_id_prefix);
                            match crate::binance::place_take_profit_order(
                                config,
                                symbol,
                                stop_side,
                                position_side,
                                quantity,
                                take_profit_price,
                                &tp_client_id,
                            ).await {
                                Ok(algo_id) => {
                                    info!("止盈单成功: algoId={}", algo_id);
                                }
                                Err(e) => {
                                    warn!("止盈单失败: {}", e);
                                }
                            }

                            // 下追踪止盈单（盈利追踪激活点数后激活）
                            let trailing_activation_points = get_trailing_activation_points();
                            let activation_price = if order_side == "BUY" {
                                entry_price + trailing_activation_points
                            } else {
                                entry_price - trailing_activation_points
                            };
                            // callbackRate 是百分比形式（不是基点），例如 0.1 = 0.1%
                            // Binance 要求最多一位小数，100点/81000 ≈ 0.123% → 0.1
                            let callback_rate = ((get_callback_profit_points() / entry_price * 100.0) * 10.0).round() / 10.0;
                            let callback_rate = callback_rate.max(0.1).min(10.0);
                            let trail_client_id = format!("{}_tr", client_order_id_prefix);
                            match crate::binance::place_trailing_stop_order(
                                config,
                                symbol,
                                stop_side,
                                position_side,
                                quantity,
                                activation_price,
                                callback_rate,
                                &trail_client_id,
                            ).await {
                                Ok(algo_id) => {
                                    info!("追踪止盈成功: algoId={}, 激活价={}, 回撤={}%", algo_id, activation_price, callback_rate);
                                }
                                Err(e) => {
                                    warn!("追踪止盈失败: {}", e);
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    warn!("获取余额失败: {}", e);
                }
            }
        }
    }

    // UTC+8 时间
    let vol_dt = chrono::DateTime::from_timestamp(vol_candle.time, 0)
        .map(|dt| {
            let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
            dt.with_timezone(&offset)
        })
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| vol_candle.time.to_string());

    let small_dt = chrono::DateTime::from_timestamp(small_candle.time, 0)
        .map(|dt| {
            let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
            dt.with_timezone(&offset)
        })
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| small_candle.time.to_string());

    let small_body = (small_candle.close - small_candle.open).abs();

    // 如果不下单（启动时），获取余额和挂单信息
    let mut account_info = String::new();
    if !should_trade {
        if let Some(config) = binance_config {
            // 获取余额
            if let Ok(balance) = crate::binance::get_balance(config, "USDC").await {
                account_info.push_str(&format!("\n**账户余额**: ${:.2} USDC\n", balance));
            }
            // 获取挂单
            match crate::binance::get_all_open_orders(config, symbol).await {
                Ok(orders) => {
                    if orders.is_empty() {
                        account_info.push_str("**当前挂单**: 无\n");
                    } else {
                        account_info.push_str("**当前挂单**:\n");
                        for order in orders.iter().take(5) {
                            account_info.push_str(&format!(
                                "- {} {} {} @ ${} (ID: {})\n",
                                order.side, order.position_side, order.orig_qty, order.price, order.order_id
                            ));
                        }
                    }
                }
                Err(e) => {
                    warn!("获取挂单失败: {}", e);
                }
            }
        }
    }

    let trade_info = if should_trade {
        format!("\n**订单数量**: {:.4}\n", quantity)
    } else {
        String::new()
    };

    // 计算 swing zone(中线对比)
    let swing_zone = {
        let sps = pinbar_detector::detect_swing_points(candles, get_swing_length());
        pinbar_detector::find_swing_zone(&sps)
    };

    let zone_section = match swing_zone {
        Some(z) => {
            // 多单(vol_is_bearish):入场在中线之下 → 顺势;空单:入场在中线之上 → 顺势
            let (status_text, status_emoji) = if vol_is_bearish {
                if entry_price < z.mid {
                    ("中线之下(顺势折扣区)", "🟢")
                } else {
                    ("中线之上(逆势溢价区,谨慎)", "⚠️")
                }
            } else {
                if entry_price > z.mid {
                    ("中线之上(顺势溢价区)", "🟢")
                } else {
                    ("中线之下(逆势折扣区,谨慎)", "⚠️")
                }
            };
            format!(
                "

**结构验证**:
- **最近 High ({})**: ${:.2}
- **最近 Low ({})**: ${:.2}
- **中线**: ${:.2}
- {} 入场 ${:.2} {}
",
                z.high_class, z.high,
                z.low_class, z.low,
                z.mid,
                status_emoji, entry_price, status_text,
            )
        }
        None => String::new(),
    };

    let message = format!(
        "### 📊 15m 倍量反转信号

**交易方向**: {} {}
**入场价格**: ${:.2}
**止损价格**: ${:.2}{}{}

**倍量K线:**
- **时间**: {} UTC+8
- **价格**: ${:.2}
- **方向**: {} {}
- **成交量倍数**: {:.1}x

**小实体K线 (实体={:.2}):**
- **时间**: {} UTC+8
- **O**: {:.2}
- **H**: {:.2}
- **L**: {:.2}
- **C**: {:.2}
- **方向**: {} {}
{}---",
        direction,
        direction_emoji,
        entry_price,
        stop_loss,
        trade_info,
        account_info,
        vol_dt,
        vol_candle.close,
        vol_emoji,
        vol_direction,
        ratio,
        small_body,
        small_dt,
        small_candle.open,
        small_candle.high,
        small_candle.low,
        small_candle.close,
        small_emoji,
        small_direction,
        zone_section
    );

    info!("发送钉钉通知: 15m 倍量报警");

    if let Err(e) = notification::send_dingtalk_markdown("15m 倍量报警", &message).await {
        warn!("钉钉通知发送失败: {}", e);
    }
}

/// 监控现有仓位，为没有追踪止盈的仓位添加追踪止盈
async fn monitor_positions(config: &crate::binance::BinanceConfig, symbol: &str) {
    let activation_profit = get_trailing_activation_points();  // 从环境变量读取
    let callback_profit = get_callback_profit_points();  // 从环境变量读取
    let protective_activation = get_protective_activation_points();  // 保护性止损激活点数
    let protective_stop_points = get_protective_stop_points();  // 保护性止损锁定点数

    // 第一次执行不等待，直接检查
    let check_and_add_trailing = || async {
        info!("[仓位监控] 检查 {} 持仓...", symbol);

        match crate::binance::get_positions(config, symbol).await {
            Ok(positions) => {
                if positions.is_empty() {
                    info!("[仓位监控] 无持仓");
                    return;
                }

                for pos in positions.iter() {
                    let entry_price = pos.entry_price;
                    let quantity = pos.position_amt.abs();
                    let position_side = &pos.position_side;

                    info!("[仓位监控] 发现持仓: {} {} @ ${:.2}", position_side, quantity, entry_price);

                    // 计算激活价格（盈利300点）和回调比例
                    let activation_price = if position_side == "LONG" {
                        entry_price + activation_profit
                    } else {
                        entry_price - activation_profit
                    };
                    // callbackRate 是百分比形式，Binance 要求最多一位小数
                    // 100点/81000 ≈ 0.123% → 0.1
                    let callback_rate = ((callback_profit / activation_price * 100.0) * 10.0).round() / 10.0;
                    let callback_rate = callback_rate.max(0.1).min(10.0);

                    // 检查是否已有追踪止盈单和止损单
                    match crate::binance::get_algo_orders(config, symbol).await {
                        Ok(existing_orders) => {
                            // 追踪止盈单是 TRAILING_STOP_MARKET 类型
                            let has_trailing = existing_orders.iter().any(|o| {
                                o.order_type == "TRAILING_STOP_MARKET" &&
                                o.position_side == *position_side
                            });

                            // 止损单是 STOP_MARKET 类型
                            let has_stop_loss = existing_orders.iter().any(|o| {
                                o.order_type == "STOP_MARKET" &&
                                o.position_side == *position_side
                            });

                            // 止盈单是 TAKE_PROFIT_MARKET 类型
                            let has_take_profit = existing_orders.iter().any(|o| {
                                o.order_type == "TAKE_PROFIT_MARKET" &&
                                o.position_side == *position_side
                            });

                            // 获取当前市值价计算盈利
                            let current_price = pos.mark_price;
                            let current_profit = if position_side == "LONG" {
                                current_price - entry_price
                            } else {
                                entry_price - current_price
                            };

                            // 检查是否已有追踪止盈单
                            if has_trailing {
                                info!("[仓位监控] {} 已有追踪止盈，跳过", position_side);
                            }

                            // 固定止盈点数
                            let fixed_profit_points = get_fixed_profit_points();

                            // 保护性止损：如果盈利超过激活点数，将止损提高到锁定盈利点位置
                            // 例如：70000开多，70350当前价，盈利350点 >= 激活300点
                            // 保护性止损 = 70000 + 100 = 70100（锁定100点利润）
                            if current_profit >= protective_activation {
                                let raw_protective_stop_price = if position_side == "LONG" {
                                    entry_price + protective_stop_points
                                } else {
                                    entry_price - protective_stop_points
                                };

                                // 按价格精度舍入，避免与现有止损价比较时因精度差异导致重复下单
                                let (_, price_precision) = crate::binance::get_precision(symbol);
                                let protective_stop_price = crate::binance::format_price(
                                    raw_protective_stop_price, price_precision
                                ).parse::<f64>().unwrap_or(raw_protective_stop_price);

                                // 获取现有的止损单价格
                                let existing_stop_price = existing_orders.iter()
                                    .filter(|o| o.order_type == "STOP_MARKET" && o.position_side == *position_side)
                                    .filter_map(|o| o.price.parse::<f64>().ok())
                                    .next();

                                // 使用 0.5 * tickSize 作为容差，避免重复下单
                                let tolerance = 0.5_f64 / 10f64.powi(price_precision as i32);

                                // 只有当新的保护性止损比现有止损更有利（超出容差）时才更新
                                let should_update = if position_side == "LONG" {
                                    existing_stop_price.map_or(true, |existing| protective_stop_price - existing > tolerance)
                                } else {
                                    existing_stop_price.map_or(true, |existing| existing - protective_stop_price > tolerance)
                                };

                                if should_update {
                                    let close_side = if position_side == "LONG" { "SELL" } else { "BUY" };
                                    let stop_client_id = format!("mon_protect_{}_{}", position_side.to_lowercase(), chrono::Utc::now().timestamp_millis());

                                    info!("[仓位监控] 添加/更新保护性止损: {} 保护价=${:.2} (盈利{}点，锁定{}点)",
                                        position_side, protective_stop_price, current_profit as i64, protective_stop_points as i64);

                                    match crate::binance::place_stop_loss_order(
                                        config,
                                        symbol,
                                        close_side,
                                        position_side,
                                        quantity,
                                        protective_stop_price,
                                        &stop_client_id,
                                    ).await {
                                        Ok(algo_id) => {
                                            info!("[仓位监控] 保护性止损成功: algoId={}", algo_id);
                                            let direction = if position_side == "LONG" { "多单" } else { "空单" };
                                            let msg = format!(
                                                "### 📊 仓位监控 - 保护性止损\n\n\
                                                - **持仓**: {} {} @ ${:.2}\n\
                                                - **方向**: {}\n\
                                                - **当前价**: ${:.2} (盈利{}点)\n\
                                                - **保护性止损价**: ${:.2} (锁定{}点)\n\
                                                - **数量**: {:.4}",
                                                symbol, direction, entry_price, direction, current_price, current_profit as i64, protective_stop_price, protective_stop_points as i64, quantity
                                            );
                                            let _ = notification::send_dingtalk_markdown("仓位监控 - 保护性止损", &msg);
                                        }
                                        Err(e) => {
                                            warn!("[仓位监控] 保护性止损失败: {}", e);
                                        }
                                    }
                                }
                            }

                            // 原有的止损单逻辑（只在没有止损单时添加初始止损）
                            if !has_stop_loss {
                                let stop_loss_price = if position_side == "LONG" {
                                    entry_price - 200.0  // 多头止损：入场价 - 200点
                                } else {
                                    entry_price + 200.0  // 空头止损：入场价 + 200点
                                };
                                let close_side = if position_side == "LONG" { "SELL" } else { "BUY" };
                                let stop_client_id = format!("mon_sl_{}_{}", position_side.to_lowercase(), chrono::Utc::now().timestamp_millis());

                                info!("[仓位监控] 添加止损单: {} {} 止损价=${:.2}", position_side, quantity, stop_loss_price);

                                match crate::binance::place_stop_loss_order(
                                    config,
                                    symbol,
                                    close_side,
                                    position_side,
                                    quantity,
                                    stop_loss_price,
                                    &stop_client_id,
                                ).await {
                                    Ok(algo_id) => {
                                        info!("[仓位监控] 止损单成功: algoId={}", algo_id);
                                        let direction = if position_side == "LONG" { "多单" } else { "空单" };
                                        let msg = format!(
                                            "### 📊 仓位监控 - 添加止损单\n\n\
                                            - **持仓**: {} {} @ ${:.2}\n\
                                            - **方向**: {}\n\
                                            - **止损价**: ${:.2} (200点)\n\
                                            - **数量**: {:.4}",
                                            symbol, direction, entry_price, direction, stop_loss_price, quantity
                                        );
                                        let _ = notification::send_dingtalk_markdown("仓位监控 - 止损单", &msg);
                                    }
                                    Err(e) => {
                                        warn!("[仓位监控] 止损单失败: {}", e);
                                    }
                                }
                            } else {
                                info!("[仓位监控] {} 已有止损单，跳过", position_side);
                            }

                            // 如果没有固定止盈单，添加固定止盈单
                            if !has_take_profit {
                                let take_profit_price = if position_side == "LONG" {
                                    entry_price + fixed_profit_points  // 多头止盈：入场价 + 固定点数
                                } else {
                                    entry_price - fixed_profit_points  // 空头止盈：入场价 - 固定点数
                                };
                                let close_side = if position_side == "LONG" { "SELL" } else { "BUY" };
                                let tp_client_id = format!("mon_tp_{}_{}", position_side.to_lowercase(), chrono::Utc::now().timestamp_millis());

                                info!("[仓位监控] 添加固定止盈单: {} {} 止盈价=${:.2}", position_side, quantity, take_profit_price);

                                match crate::binance::place_take_profit_order(
                                    config,
                                    symbol,
                                    close_side,
                                    position_side,
                                    quantity,
                                    take_profit_price,
                                    &tp_client_id,
                                ).await {
                                    Ok(algo_id) => {
                                        info!("[仓位监控] 固定止盈单成功: algoId={}", algo_id);
                                        let direction = if position_side == "LONG" { "多单" } else { "空单" };
                                        let msg = format!(
                                            "### 📊 仓位监控 - 添加固定止盈\n\n\
                                            - **持仓**: {} {} @ ${:.2}\n\
                                            - **方向**: {}\n\
                                            - **止盈价**: ${:.2} ({}点)\n\
                                            - **数量**: {:.4}",
                                            symbol, direction, entry_price, direction, take_profit_price, fixed_profit_points as i64, quantity
                                        );
                                        let _ = notification::send_dingtalk_markdown("仓位监控 - 固定止盈", &msg);
                                    }
                                    Err(e) => {
                                        warn!("[仓位监控] 固定止盈单失败: {}", e);
                                    }
                                }
                            } else {
                                info!("[仓位监控] {} 已有固定止盈单，跳过", position_side);
                            }

                            // 如果没有追踪止盈，添加追踪止盈
                            if !has_trailing {
                                let close_side = if position_side == "LONG" { "SELL" } else { "BUY" };
                                let client_id = format!("mon_tr_{}_{}", position_side.to_lowercase(), chrono::Utc::now().timestamp_millis());

                                info!("[仓位监控] 添加追踪止盈: {} {} 激活价=${:.2} 回调={:.3}%",
                                    position_side, quantity, activation_price, callback_rate);

                                match crate::binance::place_trailing_stop_order(
                                    config,
                                    symbol,
                                    close_side,
                                    position_side,
                                    quantity,
                                    activation_price,
                                    callback_rate,
                                    &client_id,
                                ).await {
                                    Ok(algo_id) => {
                                        info!("[仓位监控] 追踪止盈成功: algoId={}", algo_id);
                                        let direction = if position_side == "LONG" { "多单" } else { "空单" };
                                        let msg = format!(
                                            "### 📊 仓位监控 - 添加追踪止盈\n\n\
                                            - **持仓**: {} {} @ ${:.2}\n\
                                            - **方向**: {}\n\
                                            - **激活价**: ${:.2} (盈利300点)\n\
                                            - **回调**: {:.3}%\n\
                                            - **数量**: {:.4}",
                                            symbol, direction, entry_price, direction, activation_price, callback_rate, quantity
                                        );
                                        let _ = notification::send_dingtalk_markdown("仓位监控 - 追踪止盈", &msg);
                                    }
                                    Err(e) => {
                                        warn!("[仓位监控] 追踪止盈失败: {}", e);
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            warn!("[仓位监控] 获取挂单失败: {}", e);
                        }
                    }
                }
            }
            Err(e) => {
                warn!("[仓位监控] 获取持仓失败: {}", e);
            }
        }
    };

    // 第一次立即执行
    check_and_add_trailing().await;

    // 之后每5分钟检查一次
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(300)).await;
        check_and_add_trailing().await;
    }
}

/// 缓存的 K 线数据
struct KlineCache {
    candles: Vec<Candle>,
    timeframe: String,
    update_count: usize,
    last_pinbar_time: Option<i64>,  // 上次发送 PINBAR 通知的时间
    last_volume_time: Option<i64>,   // 上次发送倍量通知的时间
    last_fvg_time: Option<i64>,      // 上次发送 FVG 通知的时间
    last_ob_time: Option<i64>,        // 上次发送 OB 通知的时间
    daily_candles: Vec<(i64, f64, f64, f64, f64, f64)>,  // 历史日 K，用于 OB 命中检测
    daily_last_fetch: Option<i64>,    // 上次拉取日 K 的时间戳（毫秒）
}

impl KlineCache {
    fn new(timeframe: &str) -> Self {
        Self {
            candles: Vec::new(),
            timeframe: timeframe.to_string(),
            update_count: 0,
            last_pinbar_time: None,
            last_volume_time: None,
            last_fvg_time: None,
            last_ob_time: None,
            daily_candles: Vec::new(),
            daily_last_fetch: None,
        }
    }

    fn load_from_api(&mut self, data: Vec<KlineData>) {
        self.candles = data
            .into_iter()
            .map(|k| Candle {
                time: k.time,
                open: k.open,
                high: k.high,
                low: k.low,
                close: k.close,
                volume: k.volume,
            })
            .collect();
        info!("Loaded {} candles for {}", self.candles.len(), self.timeframe);
    }

    fn push(&mut self, candle: Candle) {
        // 检查是否是新股或者更新最后一根
        if let Some(last) = self.candles.last() {
            if last.time == candle.time {
                // 更新最后一根（K线还在更新中，不算新的完整K线）
                self.candles.pop();
                self.candles.push(candle);
                return;
            }
        }
        // 新K线（完整的K线）
        self.candles.push(candle);
        // 限制缓存大小
        if self.candles.len() > 5000 {
            self.candles.remove(0);
        }
        self.update_count += 1;
    }

    /// 检测并打印 PINBAR 信号，发送钉钉通知
    async fn detect_and_notify(&mut self, symbol: &str) -> Option<Signal> {
        if self.candles.len() < 50 {
            return None;
        }

        let signals = detect_recent_pinbars(
            &self.candles,
            get_swing_length(),
            SWING_RANGE,
            RECENT_SIGNALS_LIMIT,
        );

        info!("[PINBAR] 检测到 {} 个信号", signals.len());

        if signals.is_empty() {
            info!("[PINBAR] 无信号，跳过");
            return None;
        }

        let sig = signals.first().unwrap();
        info!("[PINBAR] 最新信号: time={} type={}", sig.time, sig.signal_type);

        // 去重：如果信号的 K 线时间等于上次发送的时间，则跳过
        if self.last_pinbar_time == Some(sig.time) {
            info!("[PINBAR] 去重跳过: {}", sig.time);
            return None;
        }

        // 记录发送时间
        self.last_pinbar_time = Some(sig.time);

        // 获取信号方向和评估
        let direction = if sig.signal_type == "bullish" { "🐂做多" } else { "🐻做空" };
        let near = match sig.near_swing.as_str() {
            "low" => "Swing Low",
            "high" => "Swing High",
            _ => "远离结构",
        };

        // UTC+8 时间
        let dt = chrono::DateTime::from_timestamp(sig.time, 0)
            .map(|dt| {
                let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
                dt.with_timezone(&offset)
            })
            .map(|d| d.format("%m-%d %H:%M").to_string())
            .unwrap_or_else(|| sig.time.to_string());

        let quality = if sig.strength > 0.7 && sig.near_swing != "none" {
            "⭐⭐⭐优质"
        } else if sig.strength > 0.5 {
            "⭐⭐良好"
        } else {
            "⭐一般"
        };

        // 获取 OHLC 信息
        let candle = self.candles.iter().find(|c| c.time == sig.time);
        let ohlc_msg = if let Some(c) = candle {
            format!(
                "\n**OHLC:**\n- **O**: {:.2}\n- **H**: {:.2}\n- **L**: {:.2}\n- **C**: {:.2}",
                c.open, c.high, c.low, c.close
            )
        } else {
            String::new()
        };

        // 构建并发送钉钉消息
        let signal_msg = format!(
            "PINBAR 信号\n\n### 📊 PINBAR 信号\n\n\
            - **交易对**: {}\n\
            - **周期**: {}\n\
            - **类型**: {}\n\
            - **时间**: {} UTC+8\n\
            - **价格**: ${:.2}\n\
            - **强度**: {:.0}%\n\
            - **实体**: {:.2}\n\
            - **上影**: {:.2}\n\
            - **下影**: {:.2}\n\
            - **位置**: {}\n\
            - **评估**: {}{}",
            symbol,
            self.timeframe,
            direction,
            dt,
            sig.price,
            sig.strength * 100.0,
            sig.body_size,
            sig.top_wick_size,
            sig.bottom_wick_size,
            near,
            quality,
            ohlc_msg
        );

        // 打印到终端
        let ts = chrono::Local::now().format("%H:%M:%S");
        println!();
        println!("┌─────────────────────────────────────────────────────────────────────────────┐");
        println!("│ [{}] {} {} PINBAR 信号检测                                      │", ts, symbol, self.timeframe);
        println!("├─────┬────────┬───────────┬────────┬────────┬────────┬────────┬────────────┤");
        println!("│ #   │ 类型    │ 时间(UTC+8)│ 价格   │ 强度   │ 实体   │ 上影   │ 下影   │ 位置    │ 评估       │");
        println!("├─────┼────────┼───────────┼────────┼────────┼────────┼────────┼────────┼────────────┤");

        for (i, sig) in signals.iter().enumerate() {
            let direction = if sig.signal_type == "bullish" { "🐂做多" } else { "🐻做空" };
            let near = match sig.near_swing.as_str() {
                "low" => "Swing Low",
                "high" => "Swing High",
                _ => "远离结构",
            };

            // UTC+8 时间
            let dt = chrono::DateTime::from_timestamp(sig.time, 0)
                .map(|dt| {
                    let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
                    dt.with_timezone(&offset)
                })
                .map(|d| d.format("%m-%d %H:%M").to_string())
                .unwrap_or_else(|| sig.time.to_string());

            let quality = if sig.strength > 0.7 && sig.near_swing != "none" {
                "⭐⭐⭐优质"
            } else if sig.strength > 0.5 {
                "⭐⭐良好"
            } else {
                "⭐一般"
            };

            println!(
                "│ {:3} │ {:6} │ {} │ {:7.2} │ {:5.0}% │ {:6.2} │ {:6.2} │ {:6.2} │ {:10} │ {} │",
                i + 1,
                direction,
                dt,
                sig.price,
                sig.strength * 100.0,
                sig.body_size,
                sig.top_wick_size,
                sig.bottom_wick_size,
                near,
                quality
            );
        }

        println!("└─────────────────────────────────────────────────────────────────────────────┘");
        println!();

        // 发送钉钉通知
        info!("[PINBAR] 准备发送钉钉通知...");
        if let Err(e) = notification::send_dingtalk_markdown("PINBAR 信号", &signal_msg).await {
            warn!("[PINBAR] 钉钉通知发送失败: {}", e);
        } else {
            info!("[PINBAR] 钉钉通知已发送");
        }

        // 返回最新的信号
        Some(Signal {
            time: sig.time,
            signal_type: sig.signal_type.clone(),
            price: sig.price,
            direction: direction.to_string(),
            quality: quality.to_string(),
        })
    }

    /// 检测并发送 FVG (Fair Value Gap) 钉钉通知
    /// 每根 K 线收盘时扫描所有 FVG，把 FVG.time > last_fvg_time 的全部推送
    /// （不止本周期 c2 时刻，确保任何新形成的 FVG 都能推到）
    async fn detect_fvg_and_notify(&mut self, symbol: &str) {
        // 至少需要 3 根 K 线才能检测 FVG
        if self.candles.len() < 3 {
            return;
        }

        let fvgs = detect_fvg(&self.candles, FVG_MIN_GAP_PERCENT);

        // 只取比上次通知更新的 FVG（启动扫描的 last_fvg_time 会把历史 FVG 排除掉）
        let last = self.last_fvg_time.unwrap_or(0);
        let mut new_fvgs: Vec<&FVG> = fvgs
            .iter()
            .filter(|f| f.time > last)
            .collect();

        info!("[FVG] 检测心跳: candles={} last_fvg_time={} fvgs={} new={}",
            self.candles.len(), last, fvgs.len(), new_fvgs.len());

        if new_fvgs.is_empty() {
            return;
        }

        // 按时间升序排列，逐个推送
        new_fvgs.sort_by_key(|f| f.time);

        // 先更新 last_fvg_time 到最新的，避免重复
        if let Some(latest) = new_fvgs.last() {
            self.last_fvg_time = Some(latest.time);
        }

        for fvg in new_fvgs {

            let direction = if fvg.fvg_type == "bullish" { "🐂做多" } else { "🐻做空" };
            let direction_emoji = if fvg.fvg_type == "bullish" { "🟢" } else { "🔴" };

            // UTC+8 时间
            let dt = chrono::DateTime::from_timestamp(fvg.time, 0)
                .map(|dt| {
                    let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
                    dt.with_timezone(&offset)
                })
                .map(|d| d.format("%m-%d %H:%M").to_string())
                .unwrap_or_else(|| fvg.time.to_string());

            // Fibonacci 22% 入场区（与 TS 版保持一致）
            let fvg_size = fvg.high - fvg.low;
            let entry_zone = if fvg.fvg_type == "bullish" {
                fvg.high - fvg_size * 0.22
            } else {
                fvg.low + fvg_size * 0.22
            };
            let current_price = self.candles.last().map(|c| c.close).unwrap_or(0.0);

            let tip = if fvg.fvg_type == "bullish" {
                "💡 *价格回踩 22% 区域企稳可考虑做多*"
            } else {
                "💡 *价格回踩 22% 区域受阻可考虑做空*"
            };

            let msg = format!(
                "### 📐 15m FVG 信号\n\n\
                - **交易对**: {}\n\
                - **周期**: {}\n\
                - **方向**: {} {}\n\
                - **形成时间**: {} UTC+8\n\
                - **FVG 上沿**: ${:.2}\n\
                - **FVG 下沿**: ${:.2}\n\
                - **Gap 大小**: ${:.2} ({:.3}%)\n\
                - **22% 入场区**: ${:.2}\n\
                - **当前价**: ${:.2}\n\n\
                {}",
                symbol,
                self.timeframe,
                direction_emoji,
                direction,
                dt,
                fvg.high,
                fvg.low,
                fvg.gap_size,
                fvg.gap_percent,
                entry_zone,
                current_price,
                tip
            );

            info!("[FVG] 发送钉钉通知: {} {} @ {}", symbol, fvg.fvg_type, dt);

            if let Err(e) = notification::send_dingtalk_markdown("15m FVG 信号", &msg).await {
                warn!("[FVG] 钉钉通知发送失败: {}", e);
            } else {
                info!("[FVG] 钉钉通知已发送");
            }
        }
    }

    async fn detect_ob_and_notify(&mut self, symbol: &str) {
        if self.candles.len() < 20 {
            return;
        }

        // 用 last_ob_time 排重，避免重启后重复推送历史 OB
        let last = self.last_ob_time.unwrap_or(0);
        let obs_all = detect_order_blocks(&self.candles);
        let mut new_obs: Vec<&OrderBlock> = obs_all.iter().filter(|o| o.time > last).collect();

        info!("[OB] 检测心跳: candles={} last_ob_time={} obs={} new={}",
            self.candles.len(), last, obs_all.len(), new_obs.len());

        if new_obs.is_empty() {
            return;
        }

        new_obs.sort_by_key(|o| o.time);
        if let Some(latest) = new_obs.last() {
            self.last_ob_time = Some(latest.time);
        }

        let current_price = self.candles.last().map(|c| c.close).unwrap_or(0.0);

        // 每日 K 线刷新（每小时一次）—— 用于检测 OB 是否包含历史日 K 的 high/low
        let now_ms = chrono::Utc::now().timestamp_millis();
        let need_daily_refresh = match self.daily_last_fetch {
            None => true,
            Some(t) => now_ms - t > 3600 * 1000,
        };
        if need_daily_refresh {
            if let Some(cfg) = OB_CONFIG.get() {
                match binance::fetch_klines(cfg, symbol, "1d", 7).await {
                    Ok(c) => {
                        self.daily_candles = c;
                        self.daily_last_fetch = Some(now_ms);
                        info!("[OB] 历史日 K 拉取: {} 根", self.daily_candles.len());
                    }
                    Err(e) => warn!("[OB] 拉取日 K 失败: {}", e),
                }
            }
        }

        for ob in new_obs {
            let direction = if ob.ob_type == "bullish" { "🐂做多" } else { "🐻做空" };
            let direction_emoji = if ob.ob_type == "bullish" { "🟢" } else { "🔴" };

            let dt = chrono::DateTime::from_timestamp(ob.time, 0)
                .map(|dt| {
                    let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
                    dt.with_timezone(&offset)
                })
                .map(|d| d.format("%m-%d %H:%M").to_string())
                .unwrap_or_else(|| ob.time.to_string());

            let ob_size = ob.top - ob.btm;
            let entry_zone = if ob.ob_type == "bullish" {
                ob.top - ob_size * 0.22
            } else {
                ob.btm + ob_size * 0.22
            };

            let tip = if ob.ob_type == "bullish" {
                "💡 *价格回踩 OB 22% 区域企稳可考虑做多*"
            } else {
                "💡 *价格回踩 OB 22% 区域受阻可考虑做空*"
            };

            // 检查 OB 是否包含历史日 K 的 high/low 极值
            let hl_hits = daily_hl::find_overlapped_hl(ob.top, ob.btm, &self.daily_candles);
            let high_win = !hl_hits.is_empty();
            let title_emoji = if high_win { "🎯📦" } else { "📦" };
            let title = if high_win {
                "15m OB 信号 (含历史日 K 极值 🎯)"
            } else {
                "15m OB 信号"
            };

            let hl_section = if high_win {
                let lines: Vec<String> = hl_hits.iter().map(|h| {
                    let h_dt = chrono::DateTime::from_timestamp(h.daily_time, 0)
                        .map(|dt| dt.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap()))
                        .map(|d| d.format("%m-%d").to_string())
                        .unwrap_or_default();
                    format!("  - {} @ ${:.2} ({})", h.hl_type, h.price, h_dt)
                }).collect();
                format!("\n🎯 **历史日 K 极值命中**:\n{}\n", lines.join("\n"))
            } else {
                String::new()
            };

            // 计算 swing zone(中线对比)
            let swing_zone = {
                let sps = pinbar_detector::detect_swing_points(&self.candles, get_swing_length());
                pinbar_detector::find_swing_zone(&sps)
            };

            let zone_section = match swing_zone {
                Some(z) => {
                    let is_bullish = ob.ob_type == "bullish";
                    let (status_text, status_emoji) = if is_bullish {
                        if entry_zone < z.mid {
                            ("入场区在中线之下(顺势折扣区)", "🟢")
                        } else {
                            ("入场区在中线之上(逆势溢价区,谨慎)", "⚠️")
                        }
                    } else {
                        if entry_zone > z.mid {
                            ("入场区在中线之上(顺势溢价区)", "🟢")
                        } else {
                            ("入场区在中线之下(逆势折扣区,谨慎)", "⚠️")
                        }
                    };
                    format!(
                        "\n**结构验证**:\n\
- **最近 High ({})**: ${:.2}\n\
- **最近 Low ({})**: ${:.2}\n\
- **中线**: ${:.2}\n\
- {} 22% 入场区 ${:.2} {}\n",
                        z.high_class, z.high,
                        z.low_class, z.low,
                        z.mid,
                        status_emoji, entry_zone, status_text,
                    )
                }
                None => String::new(),
            };

            let msg = format!(
                "{} 15m OB 信号\n\n\
                - **交易对**: {}\n\
                - **周期**: {}\n\
                - **方向**: {} {}\n\
                - **形成时间**: {} UTC+8\n\
                - **OB 上沿**: ${:.2}\n\
                - **OB 下沿**: ${:.2}\n\
                - **OB 大小**: ${:.2} ({:.3}%)\n\
                - **22% 入场区**: ${:.2}\n\
                - **当前价**: ${:.2}\n{}{}{}",
                title_emoji,
                symbol,
                self.timeframe,
                direction_emoji,
                direction,
                dt,
                ob.top,
                ob.btm,
                ob_size,
                ob_size / current_price * 100.0,
                entry_zone,
                current_price,
                hl_section,
                zone_section,
                tip
            );

            info!("[OB] 发送钉钉通知: {} {} @ {} hit_hl={}",
                symbol, ob.ob_type, dt, hl_hits.len());

            if let Err(e) = notification::send_dingtalk_markdown(title, &msg).await {
                warn!("[OB] 钉钉通知发送失败: {}", e);
            } else {
                info!("[OB] 钉钉通知已发送");
            }
        }
    }
}

/// PINBAR 信号结构
struct Signal {
    time: i64,
    signal_type: String,
    price: f64,
    direction: String,
    quality: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    println!("\n==========================================");
    println!("         Pinbar 实时检测服务 (CLI)");
    println!("==========================================\n");

    // 加载 .env 文件
    dotenvy::dotenv().ok();

    // 打印倍量报警比例
    let volume_ratio = get_volume_alert_ratio();
    info!("倍量报警比例: {}x", volume_ratio);

    let startup_msg = "### 🚀 Pinbar 实时检测服务已启动\n\n- **服务**: Pinbar Detector\n- **监控**: BTCUSDC @ 15m\n- **功能**: Pinbar 信号检测 + 倍量报警";
    if let Err(e) = notification::send_dingtalk_markdown("服务启动", startup_msg).await {
        eprintln!("[启动] 钉钉通知发送失败: {}", e);
    }

    let subscriptions = vec![
        ("BTCUSDC", "15m"),
    ];

    // 初始化 Binance 配置（从环境变量读取）
    let binance_config = crate::binance::BinanceConfig::from_env();
    if let Some(ref cfg) = binance_config {
        let _ = OB_CONFIG.set(cfg.clone());
        println!("✅ Binance 配置已加载");
    } else {
        println!("⚠️  未配置 Binance API（不下单）");
    }

    // 初始化缓存
    let mut caches: HashMap<String, KlineCache> = subscriptions
        .iter()
        .map(|(s, t)| {
            let key = format!("{}@{}", s, t);
            (key, KlineCache::new(t))
        })
        .collect();

    // 1. 先通过 Binance REST API 获取历史 K 线数据
    info!("Fetching historical klines from Binance API...");

    for (symbol, tf) in &subscriptions {
        let key = format!("{}@{}", symbol, tf);
        // Binance REST API: /fapi/v1/klines 返回数组格式
        let url = format!("{}/fapi/v1/klines?symbol={}&interval=15m&limit=1000", BINANCE_REST_URL, symbol);

        match reqwest::get(&url).await {
            Ok(resp) => {
                if let Ok(data) = resp.json::<BinanceRestKline>().await {
                    // 解析 Binance 数组格式: [[t, o, c, h, l, v, ...], ...]
                    let klines: Vec<KlineData> = data.iter().filter_map(|arr| {
                        if let Some(arr) = arr.as_array() {
                            if arr.len() >= 6 {
                                let time = arr[0].as_i64().unwrap_or(0) / 1000;
                                let open = arr[1].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                                let high = arr[2].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                                let low = arr[3].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                                let close = arr[4].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                                let volume = arr[5].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                                return Some(KlineData { time, open, high, low, close, volume });
                            }
                        }
                        None
                    }).collect();
                    if let Some(cache) = caches.get_mut(&key) {
                        cache.load_from_api(klines);
                        // 启动时只加载数据,OB 报警由下面"启动时发送最近 OB"段统一处理
                        // (避免 REST 加载后立即推 OB 时 last_ob_time=None,导致所有历史 OB 全发)
                    }
                }
            }
            Err(e) => {
                warn!("Failed to fetch {}: {}", key, e);
            }
        }
    }

    println!("\n历史数据加载完成，开始监听实时 K 线...\n");

    // 加载完后推送最近 swing zone(只显示最近一个 HH + 一个 LL + 中线)
    for (symbol, tf) in &subscriptions {
        let key = format!("{}@{}", symbol, tf);
        if let Some(cache) = caches.get(&key) {
            let candles = &cache.candles;
            if candles.len() >= get_swing_length() + 5 {
                let sps = pinbar_detector::detect_swing_points(candles, get_swing_length());
                let zone = pinbar_detector::find_swing_zone(&sps);

                let fmt_ts = |ts: i64| -> String {
                    chrono::DateTime::from_timestamp(ts, 0)
                        .map(|dt| {
                            let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
                            dt.with_timezone(&offset)
                        })
                        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_else(|| ts.to_string())
                };

                let last_close = candles.last().map(|c| c.close).unwrap_or(0.0);

                let zone_msg = match zone {
                    Some(z) => format!(
                        "### 📐 服务就绪 - 最近 Swing\n\n\
**监控**: {} @ {}\n\n\
**最新价**: ${:.2}\n\n\
**最近 High ({})**: ${:.2} @ {}\n\n\
**最近 Low ({})**: ${:.2} @ {}\n\n\
**中线**: ${:.2}",
                        symbol, tf,
                        last_close,
                        z.high_class, z.high, fmt_ts(z.high_time),
                        z.low_class, z.low, fmt_ts(z.low_time),
                        z.mid,
                    ),
                    None => format!(
                        "### 📐 服务就绪 - Swing 数据不足\n\n**监控**: {} @ {}",
                        symbol, tf
                    ),
                };

                info!("发送钉钉通知: 最近 Swing");
                if let Err(e) = notification::send_dingtalk_markdown("服务就绪 - 最近 Swing", &zone_msg).await {
                    warn!("Swing 钉钉通知失败: {}", e);
                }
            }
        }
    }

    // 发送最近 PINBAR 信号的钉钉通知（启动时证明检测能力）
    for (symbol, tf) in &subscriptions {
        let key = format!("{}@{}", symbol, tf);
        if let Some(cache) = caches.get_mut(&key) {
            if cache.candles.len() >= 50 {
                let signals = detect_recent_pinbars(&cache.candles, get_swing_length(), SWING_RANGE, 1);
                if let Some(sig) = signals.first() {
                    // 设置 last_pinbar_time 避免启动后再发一次
                    cache.last_pinbar_time = Some(sig.time);

                    let direction = if sig.signal_type == "bullish" { "🐂做多" } else { "🐻做空" };
                    let near = match sig.near_swing.as_str() {
                        "low" => "Swing Low",
                        "high" => "Swing High",
                        _ => "远离结构",
                    };
                    let dt = chrono::DateTime::from_timestamp(sig.time, 0)
                        .map(|dt| {
                            let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
                            dt.with_timezone(&offset)
                        })
                        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_else(|| sig.time.to_string());
                    let quality = if sig.strength > 0.7 && sig.near_swing != "none" {
                        "⭐⭐⭐优质"
                    } else if sig.strength > 0.5 {
                        "⭐⭐良好"
                    } else {
                        "⭐一般"
                    };
                    let candle = cache.candles.iter().find(|c| c.time == sig.time);
                    let ohlc_msg = if let Some(c) = candle {
                        format!(
                            "\n**OHLC:**\n- **O**: {:.2}\n- **H**: {:.2}\n- **L**: {:.2}\n- **C**: {:.2}",
                            c.open, c.high, c.low, c.close
                        )
                    } else {
                        String::new()
                    };
                    let signal_msg = format!(
                        "PINBAR 信号\n\n### 📊 PINBAR 信号\n\n\
                        - **交易对**: {}\n\
                        - **周期**: {}\n\
                        - **类型**: {}\n\
                        - **时间**: {} UTC+8\n\
                        - **价格**: ${:.2}\n\
                        - **强度**: {:.0}%\n\
                        - **实体**: {:.2}\n\
                        - **上影**: {:.2}\n\
                        - **下影**: {:.2}\n\
                        - **位置**: {}\n\
                        - **评估**: {}{}",
                        symbol,
                        tf,
                        direction,
                        dt,
                        sig.price,
                        sig.strength * 100.0,
                        sig.body_size,
                        sig.top_wick_size,
                        sig.bottom_wick_size,
                        near,
                        quality,
                        ohlc_msg
                    );
                    let _ = notification::send_dingtalk_markdown("PINBAR 信号", &signal_msg);
                }
            }
        }
    }

    // 发送最近倍量反转信号的钉钉通知
    for (symbol, tf) in &subscriptions {
        let key = format!("{}@{}", symbol, tf);
        if let Some(cache) = caches.get_mut(&key) {
            if cache.candles.len() >= 4 {
                // 检测倍量反转形态
                if let Some((index, ratio, small_index)) = check_volume_alert(&cache.candles) {
                    // 设置 last_volume_time 避免启动后再发一次
                    cache.last_volume_time = Some(cache.candles[index].time);
                    let candles = cache.candles.clone();
                    // 启动时 should_trade=false，仅报警不下单
                    send_volume_alert(symbol, &candles, index, ratio, small_index, binance_config.as_ref(), false).await;
                }
            }
        }
    }

    // 启动时发送最近 OB 报告（推送最近 1 条，设置 last_ob_time 避免重复）
    for (symbol, tf) in &subscriptions {
        let key = format!("{}@{}", symbol, tf);
        if let Some(cache) = caches.get_mut(&key) {
            if cache.candles.len() >= 20 {
                let obs_all = detect_order_blocks(&cache.candles);
                if let Some(latest) = obs_all.iter().max_by_key(|o| o.time) {
                    cache.last_ob_time = Some(latest.time);

                    let dt = chrono::DateTime::from_timestamp(latest.time, 0)
                        .map(|dt| {
                            let offset = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
                            dt.with_timezone(&offset)
                        })
                        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_else(|| latest.time.to_string());

                    let direction = if latest.ob_type == "bullish" { "🐂做多" } else { "🐻做空" };
                    let direction_emoji = if latest.ob_type == "bullish" { "🟢" } else { "🔴" };
                    let ob_size = latest.top - latest.btm;
                    let entry_zone = if latest.ob_type == "bullish" {
                        latest.top - ob_size * 0.22
                    } else {
                        latest.btm + ob_size * 0.22
                    };
                    let current_price = cache.candles.last().map(|c| c.close).unwrap_or(0.0);

                    let startup_msg = format!(
                        "### 🚀 服务启动 - 最近 15m OB\n\n\
                        - **交易对**: {}\n\
                        - **周期**: {}\n\
                        - **方向**: {} {}\n\
                        - **形成时间**: {} UTC+8\n\
                        - **OB 上沿**: ${:.2}\n\
                        - **OB 下沿**: ${:.2}\n\
                        - **OB 大小**: ${:.2}\n\
                        - **22% 入场区**: ${:.2}\n\
                        - **当前价**: ${:.2}\n\n\
                        *Pinbar 检测服务已启动，开始实时监控*",
                        symbol,
                        tf,
                        direction_emoji,
                        direction,
                        dt,
                        latest.top,
                        latest.btm,
                        ob_size,
                        entry_zone,
                        current_price
                    );

                    info!("[OB] 启动发送最近 OB 报告: {} {} @ {}", symbol, latest.ob_type, dt);
                    if let Err(e) = notification::send_dingtalk_markdown("服务启动 - 最近 OB", &startup_msg).await {
                        warn!("[OB] 启动钉钉通知失败: {}", e);
                    }
                } else {
                    info!("[OB] 启动扫描：历史中暂无符合条件的 OB");
                }
            }
        }
    }

    // 2. 连接到 Binance WebSocket 实时更新
    info!("Connecting to Binance WebSocket...");
    let (ws_stream, _) = connect_async(BINANCE_WS_URL).await?;
    let (mut write, mut read) = ws_stream.split();
    info!("Connected to Binance WebSocket");

    // 3. 启动时先执行一次仓位监控（后台执行，不阻塞）
    let binance_config_clone2 = binance_config.clone();
    let monitor_symbol2 = subscriptions.first().unwrap().0.clone();
    tokio::spawn(async move {
        if let Some(config) = binance_config_clone2 {
            info!("[启动] 执行仓位监控...");
            monitor_positions(&config, &monitor_symbol2).await;
            info!("[启动] 仓位监控完成");
        }
    });

    // 4. 启动仓位监控（定期检查现有仓位，添加追踪止盈）
    let binance_config_clone = binance_config.clone();
    let monitor_symbol = subscriptions.first().unwrap().0.clone();
    tokio::spawn(async move {
        if let Some(config) = binance_config_clone {
            // 先等待一小段时间，避免与启动时的监控重复
            tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
            monitor_positions(&config, &monitor_symbol).await;
        }
    });

    // 5. 处理实时 K 线 (Binance WebSocket)
    debug!("[DEBUG] 准备进入Binance WebSocket循环");
    while let Some(msg) = read.next().await {
        match msg? {
            Message::Text(text) => {
                debug!("[WS] 收到消息: {}", &text[..text.len().min(200)]);
                if let Ok(binance_msg) = serde_json::from_str::<BinanceKlineMsg>(&text) {
                    if binance_msg.e == "kline" {
                        if let Some(kline) = binance_msg.k {
                            debug!("[WS] Binance K线: t={} x={} o={} c={} v={}", kline.t, kline.x, kline.o, kline.c, kline.v);
                            // 只处理已闭合的 K 线 (x=true)
                            if kline.x {
                                info!("[WS] Binance K线已闭合: t={} o={} c={} v={} chg={}", kline.t, kline.o, kline.c, kline.v, (kline.c.parse::<f64>().unwrap_or(0.0) - kline.o.parse::<f64>().unwrap_or(0.0)).abs());
                                let candle = Candle {
                                    time: kline.t / 1000,  // 转为秒
                                    open: kline.o.parse().unwrap_or(0.0),
                                    high: kline.h.parse().unwrap_or(0.0),
                                    low: kline.l.parse().unwrap_or(0.0),
                                    close: kline.c.parse().unwrap_or(0.0),
                                    volume: kline.v.parse().unwrap_or(0.0),
                                };

                                // 更新所有缓存（简化处理：更新所有）
                                for (key, cache) in caches.iter_mut() {
                                    let prev_len = cache.candles.len();
                                    cache.push(candle.clone());

                                    // 只有在新K线添加时（非更新最后一根）才检测
                                    if cache.candles.len() > prev_len {
                                        info!("[{}] [Kline] 新K线到达: {} candle_time={} len={} last_fvg_time={:?}",
                                            chrono::Local::now().format("%H:%M:%S"),
                                            key,
                                            candle.time,
                                            cache.candles.len(),
                                            cache.last_fvg_time);

                                        // PINBAR 检测（新的完整K线）- detect_and_notify 内部会发送钉钉通知
                                        let parts: Vec<&str> = key.split('@').collect();
                                        if parts.len() == 2 {
                                            cache.detect_ob_and_notify(parts[0]).await;
                                        }

                                        // 倍量报警检测
                                        if cache.candles.len() >= 4 {
                                            if let Some((vol_index, ratio, small_index)) =
                                                check_volume_alert(&cache.candles)
                                            {
                                                // 去重：如果倍量K线时间等于上次发送的时间，则跳过
                                                let vol_time = cache.candles[vol_index].time;
                                                if cache.last_volume_time == Some(vol_time) {
                                                    debug!("[Volume] 去重跳过: {}", vol_time);
                                                } else {
                                                    cache.last_volume_time = Some(vol_time);
                                                    info!("[Volume] 检测到倍量反转，准备发送报警: {}", vol_time);
                                                    let parts: Vec<&str> = key.split('@').collect();
                                                    if parts.len() == 2 {
                                                        let symbol = parts[0];
                                                        let candles = cache.candles.clone();
                                                        // 运行时 should_trade=ENABLE_TRADING，决定是否实际下单
                                                        send_volume_alert(
                                                            symbol,
                                                            &candles,
                                                            vol_index,
                                                            ratio,
                                                            small_index,
                                                            binance_config.as_ref(),
                                                            get_enable_trading(),
                                                        )
                                                        .await;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Message::Close(_) => {
                warn!("K-line server closed connection");
                break;
            }
            _ => {}
        }
    }

    Ok(())
}