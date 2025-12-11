mod config;
mod grid_engine;
mod user_stream;
mod ws_order;

use anyhow::Result;
use config::{Config, Direction};
use grid_engine::GridEngine;
use ws_order::WsOrderManager;
use user_stream::UserStream;
use futures_util::StreamExt;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};
use serde::Deserialize;
use std::time::Duration;
use std::sync::Arc;

/// WebSocket 价格更新
#[derive(Debug, Deserialize)]
struct WsAggTrade {
    #[serde(rename = "p")]
    price: String,
}

/// 解析命令行参数
fn parse_args() -> String {
    let args: Vec<String> = std::env::args().collect();

    // 查找 --config 参数
    for i in 0..args.len() {
        if args[i] == "--config" && i + 1 < args.len() {
            return args[i + 1].clone();
        }
    }

    // 默认配置文件
    "config.toml".to_string()
}

#[tokio::main]
async fn main() -> Result<()> {
    // 初始化日志
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "rolling_service=info".to_string())
        )
        .with_target(false)
        .init();

    info!("=== 滚仓策略服务 v0.1.0 ===");

    // 加载配置
    let config_file = parse_args();
    info!("加载配置文件: {}", config_file);
    let config = Config::load(&config_file)?;
    info!("配置加载成功");
    info!("交易对: {}", config.grid.symbol);
    let direction_str = match config.grid.direction {
        Direction::Long => "做多 (价格下方挂买单)",
        Direction::Short => "做空 (价格上方挂卖单)",
    };
    info!("方向: {}", direction_str);
    info!("网格间距: {} USDT", config.grid.grid_spacing);
    info!("网格数量: {}", config.grid.grid_count);
    info!("每单保证金: {} USDT", config.grid.order_margin);
    info!("最大保证金: {} USDT", config.grid.max_margin);
    info!("杠杆: {}x", config.grid.leverage);
    info!("止盈目标价: {:.2}", config.rolling.target_price);
    if config.rolling.stop_loss_percent > 0.0 {
        info!("止损: {}%", config.rolling.stop_loss_percent);
    } else {
        info!("止损: 未设置");
    }
    if config.rolling.use_rolling_margin {
        info!("滚仓模式: 启用 (滚仓比例: {}%)", config.rolling.roll_profit_ratio);
    } else {
        info!("滚仓模式: 未启用");
    }
    // 计算停止补单价
    let stop_price = if config.grid.direction == Direction::Long {
        config.rolling.target_price * (1.0 - config.rolling.stop_roll_distance / 100.0)
    } else {
        config.rolling.target_price * (1.0 + config.rolling.stop_roll_distance / 100.0)
    };
    info!("停止补单价: {:.2} (距目标{}%)", stop_price, config.rolling.stop_roll_distance);

    // 创建 WebSocket 订单管理器
    let api = Arc::new(WsOrderManager::new(config.binance.clone()));

    // 等待 WebSocket 连接建立
    tokio::time::sleep(Duration::from_secs(1)).await;

    // 设置杠杆
    api.set_leverage(&config.grid.symbol, config.grid.leverage).await?;

    // 获取当前价格
    let initial_price = api.get_price(&config.grid.symbol).await?;
    info!("当前价格: {}", initial_price);

    // 初始化网格引擎
    let engine = Arc::new(GridEngine::new(
        config.grid.clone(),
        config.rolling.clone(),
        initial_price,
    ));

    // 同步持仓信息
    if let Ok(Some(pos)) = api.get_position(&config.grid.symbol).await {
        let qty: f64 = pos.position_amt.parse().unwrap_or(0.0);
        let entry: f64 = pos.entry_price.parse().unwrap_or(0.0);
        let pnl: f64 = pos.unrealized_profit.parse().unwrap_or(0.0);
        if qty > 0.0 {
            engine.update_position(qty, entry, pnl).await;
            info!("同步持仓: {} ETH @ {}, 浮盈: {:.2}", qty, entry, pnl);

            // 如果有持仓，下止盈单
            if let Some(tp_action) = engine.calculate_take_profit().await {
                match api.place_take_profit(
                    &config.grid.symbol,
                    tp_action.price,
                    tp_action.quantity,
                    &tp_action.client_order_id,
                    tp_action.is_buy,
                ).await {
                    Ok(_) => {
                        engine.set_take_profit_order_id(Some(tp_action.client_order_id)).await;
                        info!("止盈单已设置");
                    }
                    Err(e) => error!("止盈单失败: {}", e),
                }
            }

            // 如果配置了止损，下止损单
            if config.rolling.stop_loss_percent > 0.0 {
                if let Some(sl_action) = engine.calculate_stop_loss().await {
                    match api.place_stop_loss(
                        &config.grid.symbol,
                        sl_action.price,
                        sl_action.quantity,
                        &sl_action.client_order_id,
                        sl_action.is_buy,
                    ).await {
                        Ok(_) => {
                            engine.set_stop_loss_order_id(Some(sl_action.client_order_id)).await;
                            info!("止损单已设置");
                        }
                        Err(e) => error!("止损单失败: {}", e),
                    }
                }
            }
        }
    }

    // 初始化网格订单
    let init_orders = engine.initialize(initial_price).await;
    for order in init_orders {
        match api.place_limit_order(
            &config.grid.symbol,
            order.price,
            order.quantity,
            &order.client_order_id,
            order.is_buy,
        ).await {
            Ok(resp) => {
                engine.on_order_placed(
                    &order.client_order_id,
                    resp.order_id,
                    order.price,
                    order.quantity,
                ).await;
            }
            Err(e) => error!("下单失败 @ {}: {}", order.price, e),
        }
    }

    // 启动用户数据流
    let user_stream = UserStream::new(config.binance.clone());
    let mut order_rx = user_stream.start().await?;
    info!("用户数据流已启动");

    let engine_order = engine.clone();
    let api_order = api.clone();
    let symbol_order = config.grid.symbol.clone();
    let stop_loss_percent = config.rolling.stop_loss_percent;
    let is_long = engine.is_long();

    // 订单更新处理循环
    tokio::spawn(async move {
        while let Some(update) = order_rx.recv().await {
            // 只处理当前交易对
            if update.symbol != symbol_order {
                continue;
            }

            // 处理入场单成交（做多=买单成交, 做空=卖单成交）
            let is_entry_fill = if is_long {
                update.side == "BUY" && update.client_order_id.starts_with("roll_b_")
            } else {
                update.side == "SELL" && update.client_order_id.starts_with("roll_s_")
            };

            if is_entry_fill && update.order_status == "FILLED" {
                let side_str = if is_long { "买单" } else { "卖单" };
                info!("检测到{}成交: {} @ {}", side_str, update.filled_qty, update.filled_price);

                // 更新引擎状态
                let need_update_tp = engine_order.on_entry_filled(
                    &update.client_order_id,
                    update.filled_price,
                    update.filled_qty,
                ).await;

                if need_update_tp {
                    // 取消旧止盈单
                    if let Some(old_tp_id) = engine_order.get_take_profit_order_id().await {
                        let _ = api_order.cancel_order(&symbol_order, &old_tp_id).await;
                    }

                    // 下新止盈单
                    if let Some(tp_action) = engine_order.calculate_take_profit().await {
                        match api_order.place_take_profit(
                            &symbol_order,
                            tp_action.price,
                            tp_action.quantity,
                            &tp_action.client_order_id,
                            tp_action.is_buy,
                        ).await {
                            Ok(_) => {
                                engine_order.set_take_profit_order_id(Some(tp_action.client_order_id)).await;
                                info!("止盈单已更新");
                            }
                            Err(e) => error!("更新止盈单失败: {}", e),
                        }
                    }

                    // 如果配置了止损，更新止损单
                    if stop_loss_percent > 0.0 {
                        // 取消旧止损单
                        if let Some(old_sl_id) = engine_order.get_stop_loss_order_id().await {
                            let _ = api_order.cancel_order(&symbol_order, &old_sl_id).await;
                        }

                        // 下新止损单
                        if let Some(sl_action) = engine_order.calculate_stop_loss().await {
                            match api_order.place_stop_loss(
                                &symbol_order,
                                sl_action.price,
                                sl_action.quantity,
                                &sl_action.client_order_id,
                                sl_action.is_buy,
                            ).await {
                                Ok(_) => {
                                    engine_order.set_stop_loss_order_id(Some(sl_action.client_order_id)).await;
                                    info!("止损单已更新");
                                }
                                Err(e) => error!("更新止损单失败: {}", e),
                            }
                        }
                    }
                }
            }

            // 处理止盈/止损成交（做多=卖单平仓, 做空=买单平仓）
            if update.order_status == "FILLED" {
                if update.client_order_id.starts_with("roll_tp_") {
                    info!("止盈单成交: {} @ {}", update.filled_qty, update.filled_price);
                    engine_order.on_close_filled(update.filled_price).await;

                    // 取消止损单
                    if let Some(sl_id) = engine_order.get_stop_loss_order_id().await {
                        let _ = api_order.cancel_order(&symbol_order, &sl_id).await;
                    }
                } else if update.client_order_id.starts_with("roll_sl_") {
                    info!("止损单成交: {} @ {}", update.filled_qty, update.filled_price);
                    engine_order.on_close_filled(update.filled_price).await;

                    // 取消止盈单
                    if let Some(tp_id) = engine_order.get_take_profit_order_id().await {
                        let _ = api_order.cancel_order(&symbol_order, &tp_id).await;
                    }
                }
            }

            // 处理订单取消
            if update.order_status == "CANCELED" {
                engine_order.on_order_cancelled(&update.client_order_id).await;
            }
        }
    });

    // 启动价格WebSocket
    let ws_url = format!("{}/{}@aggTrade", api.get_ws_url(), config.grid.symbol.to_lowercase());
    info!("连接价格WebSocket: {}", ws_url);

    let engine_price = engine.clone();
    let api_price = api.clone();
    let symbol_price = config.grid.symbol.clone();

    // 价格更新循环
    tokio::spawn(async move {
        loop {
            match connect_async(&ws_url).await {
                Ok((ws_stream, _)) => {
                    info!("价格WebSocket已连接");
                    let (_, mut read) = ws_stream.split();

                    while let Some(msg) = read.next().await {
                        match msg {
                            Ok(Message::Text(text)) => {
                                if let Ok(trade) = serde_json::from_str::<WsAggTrade>(&text) {
                                    if let Ok(price) = trade.price.parse::<f64>() {
                                        // 更新价格
                                        engine_price.update_price(price).await;

                                        // 检查是否需要补单
                                        let (new_orders, to_cancel) = engine_price
                                            .check_and_supplement_orders(price).await;

                                        // 撤销过期订单
                                        for (_order_id, client_id) in to_cancel {
                                            if let Err(e) = api_price.cancel_order(&symbol_price, &client_id).await {
                                                error!("撤单失败: {}", e);
                                            } else {
                                                engine_price.on_order_cancelled(&client_id).await;
                                            }
                                        }

                                        // 下新订单
                                        for order in new_orders {
                                            match api_price.place_limit_order(
                                                &symbol_price,
                                                order.price,
                                                order.quantity,
                                                &order.client_order_id,
                                                order.is_buy,
                                            ).await {
                                                Ok(resp) => {
                                                    engine_price.on_order_placed(
                                                        &order.client_order_id,
                                                        resp.order_id,
                                                        order.price,
                                                        order.quantity,
                                                    ).await;
                                                }
                                                Err(e) => error!("补单失败 @ {}: {}", order.price, e),
                                            }
                                        }
                                    }
                                }
                            }
                            Ok(Message::Ping(_)) => {
                                // 响应ping
                            }
                            Err(e) => {
                                error!("价格WebSocket错误: {}", e);
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    error!("价格WebSocket连接失败: {}", e);
                }
            }

            warn!("价格WebSocket断开，5秒后重连...");
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    // 定时打印统计信息
    let engine_stats = engine.clone();
    let stats_is_long = engine.is_long();
    tokio::spawn(async move {
        let order_type = if stats_is_long { "买单" } else { "卖单" };
        let pos_type = if stats_is_long { "多头" } else { "空头" };
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let (order_count, pos_qty, pos_price) = engine_stats.get_stats().await;
            let current_price = engine_stats.get_current_price().await;
            let unrealized_pnl = engine_stats.calculate_unrealized_pnl().await;

            if pos_qty > 0.0 {
                let pnl_pct = if stats_is_long {
                    (current_price / pos_price - 1.0) * 100.0
                } else {
                    (pos_price / current_price - 1.0) * 100.0
                };
                info!("统计: {}={}个, {}持仓={:.4} ETH @ {:.2}, 当前价={:.2}, 浮盈={:.2} ({:.2}%)",
                      order_type, order_count, pos_type, pos_qty, pos_price, current_price, unrealized_pnl, pnl_pct);
            } else {
                info!("统计: {}={}个, 无持仓, 当前价={:.2}", order_type, order_count, current_price);
            }
        }
    });

    // 保持主线程运行
    info!("服务已启动，按 Ctrl+C 退出");
    tokio::signal::ctrl_c().await?;
    info!("收到停止信号，清理中...");

    // 可选：退出时取消所有订单
    // api.cancel_all_orders(&config.grid.symbol).await?;

    Ok(())
}
