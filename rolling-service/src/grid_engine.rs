use crate::config::{Direction, GridConfig, RollingConfig};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info};

/// 活跃订单
#[derive(Debug, Clone)]
pub struct ActiveOrder {
    pub client_order_id: String,
    pub order_id: i64,
    pub price: f64,
    pub quantity: f64,
    pub filled_qty: f64,
}

/// 持仓信息
#[derive(Debug, Clone, Default)]
pub struct Position {
    pub quantity: f64,      // 持仓数量
    pub entry_price: f64,   // 持仓均价
    pub unrealized_pnl: f64,
}

/// 网格订单动作（入场单）
#[derive(Debug, Clone)]
pub struct GridOrderAction {
    pub price: f64,
    pub quantity: f64,
    pub client_order_id: String,
    pub is_buy: bool,       // true=买单(做多入场), false=卖单(做空入场)
}

/// 止盈/止损单动作
#[derive(Debug, Clone)]
pub struct CloseOrderAction {
    pub price: f64,
    pub quantity: f64,
    pub client_order_id: String,
    pub is_buy: bool,       // true=买单(做空止盈/止损), false=卖单(做多止盈/止损)
}

/// 网格引擎 - 滚仓版（支持做多/做空）
#[derive(Clone)]
pub struct GridEngine {
    grid_config: GridConfig,
    rolling_config: RollingConfig,
    direction: Direction,                    // 交易方向
    base_price: Arc<RwLock<f64>>,           // 基准价格
    current_price: Arc<RwLock<f64>>,        // 当前价格
    orders: Arc<RwLock<HashMap<String, ActiveOrder>>>,  // 活跃挂单
    position: Arc<RwLock<Position>>,        // 当前持仓
    take_profit_order_id: Arc<RwLock<Option<i64>>>,  // 当前止盈单 algo_id
    stop_loss_order_id: Arc<RwLock<Option<i64>>>,    // 当前止损单 algo_id
    total_margin: Arc<RwLock<f64>>,         // 累计投入保证金 (USDT)
}

impl GridEngine {
    pub fn new(grid_config: GridConfig, rolling_config: RollingConfig, initial_price: f64) -> Self {
        let direction = grid_config.direction;
        Self {
            grid_config,
            rolling_config,
            direction,
            base_price: Arc::new(RwLock::new(initial_price)),
            current_price: Arc::new(RwLock::new(initial_price)),
            orders: Arc::new(RwLock::new(HashMap::new())),
            position: Arc::new(RwLock::new(Position::default())),
            take_profit_order_id: Arc::new(RwLock::new(None)),
            stop_loss_order_id: Arc::new(RwLock::new(None)),
            total_margin: Arc::new(RwLock::new(0.0)),
        }
    }

    /// 根据保证金和当前价格计算下单数量
    /// 数量 = 保证金 * 杠杆 / 价格
    fn calculate_quantity_from_margin(&self, margin: f64, price: f64) -> f64 {
        let leverage = self.grid_config.leverage as f64;
        let quantity = margin * leverage / price;
        let factor = 10_f64.powi(self.grid_config.quantity_precision as i32);
        (quantity * factor).round() / factor
    }

    /// 获取交易方向
    pub fn get_direction(&self) -> Direction {
        self.direction
    }

    /// 是否做多
    pub fn is_long(&self) -> bool {
        self.direction == Direction::Long
    }

    /// 初始化：根据方向在价格上方或下方创建网格订单
    /// 做多: 价格下方挂买单
    /// 做空: 价格上方挂卖单
    /// 如果设置了 start_roll_distance，则等盈利达到后再下单
    pub async fn initialize(&self, base_price: f64) -> Vec<GridOrderAction> {
        *self.base_price.write().await = base_price;

        // 如果设置了开始补单距离，初始化时不下单，等盈利后再补
        if self.rolling_config.start_roll_distance > 0.0 {
            info!("初始化跳过: 需盈利 {:.1}% 后开始下单", self.rolling_config.start_roll_distance);
            return Vec::new();
        }

        let mut actions = Vec::new();
        let spacing = self.grid_config.grid_spacing;
        let is_long = self.is_long();
        let order_margin = self.grid_config.order_margin;

        for i in 0..self.grid_config.grid_count {
            let price = if is_long {
                // 做多：价格下方
                Self::round_price(
                    base_price - (i + 1) as f64 * spacing,
                    self.grid_config.price_precision,
                )
            } else {
                // 做空：价格上方
                Self::round_price(
                    base_price + (i + 1) as f64 * spacing,
                    self.grid_config.price_precision,
                )
            };

            // 根据保证金计算下单数量
            let quantity = self.calculate_quantity_from_margin(order_margin, price);
            let client_order_id = self.generate_client_order_id(price);

            actions.push(GridOrderAction {
                price,
                quantity,
                client_order_id,
                is_buy: is_long,  // 做多=买单入场，做空=卖单入场
            });
        }

        let direction_str = if is_long { "做多" } else { "做空" };
        let order_type = if is_long { "买单" } else { "卖单" };
        info!("初始化网格({}): 基准价={}, 创建{}个{}, 每单保证金={} USDT",
              direction_str, base_price, actions.len(), order_type, order_margin);
        actions
    }

    /// 更新当前价格
    pub async fn update_price(&self, new_price: f64) {
        *self.current_price.write().await = new_price;
    }

    /// 获取当前价格
    pub async fn get_current_price(&self) -> f64 {
        *self.current_price.read().await
    }

    /// 记录订单已挂出
    pub async fn on_order_placed(&self, client_order_id: &str, order_id: i64, price: f64, quantity: f64) {
        let order = ActiveOrder {
            client_order_id: client_order_id.to_string(),
            order_id,
            price,
            quantity,
            filled_qty: 0.0,
        };
        self.orders.write().await.insert(client_order_id.to_string(), order);
        debug!("订单已记录: {} @ {}", client_order_id, price);
    }

    /// 入场单成交：更新持仓，返回是否需要更新止盈单
    /// 做多: 买单成交
    /// 做空: 卖单成交
    pub async fn on_entry_filled(&self, client_order_id: &str, filled_price: f64, filled_qty: f64) -> bool {
        // 从活跃订单中移除
        self.orders.write().await.remove(client_order_id);

        // 更新持仓
        let mut pos = self.position.write().await;
        let old_qty = pos.quantity;
        let old_cost = old_qty * pos.entry_price;
        let new_cost = filled_qty * filled_price;

        pos.quantity = old_qty + filled_qty;
        if pos.quantity > 0.0 {
            pos.entry_price = (old_cost + new_cost) / pos.quantity;
        }

        // 累计投入保证金 = 成交金额 / 杠杆
        let leverage = self.grid_config.leverage as f64;
        let margin_used = new_cost / leverage;
        *self.total_margin.write().await += margin_used;

        let total_margin = *self.total_margin.read().await;
        let direction_str = if self.is_long() { "买单" } else { "卖单" };
        info!("{}成交: {} @ {}, 持仓: {:.4} -> {:.4}, 均价: {:.2}, 已用保证金: {:.2} USDT",
              direction_str, filled_qty, filled_price, old_qty, pos.quantity, pos.entry_price, total_margin);

        // 返回 true 表示需要更新止盈单
        true
    }

    /// 计算浮盈（用于滚仓）
    /// 做多: 价格上涨盈利
    /// 做空: 价格下跌盈利
    pub async fn calculate_unrealized_pnl(&self) -> f64 {
        let pos = self.position.read().await;
        let current_price = *self.current_price.read().await;

        if pos.quantity <= 0.0 {
            return 0.0;
        }

        if self.is_long() {
            // 做多：价格上涨盈利
            (current_price - pos.entry_price) * pos.quantity
        } else {
            // 做空：价格下跌盈利
            (pos.entry_price - current_price) * pos.quantity
        }
    }

    /// 计算滚仓后的订单保证金和数量
    /// 如果设置了 max_margin 且已达到，则只用浮盈加仓
    /// 返回: 订单数量
    pub async fn calculate_rolling_order_size(&self, order_price: f64) -> f64 {
        let total_margin = *self.total_margin.read().await;
        let max_margin = self.grid_config.max_margin;
        let base_margin = self.grid_config.order_margin;

        // 检查是否达到最大保证金
        let reached_max = max_margin > 0.0 && total_margin >= max_margin;

        // 计算浮盈部分
        let unrealized_pnl = self.calculate_unrealized_pnl().await;
        let has_profit = unrealized_pnl > 0.0 && self.rolling_config.use_rolling_margin;

        // 情况1: 达到最大保证金
        if reached_max {
            if !has_profit {
                // 没有浮盈，不能加仓
                info!("已达最大保证金 {:.2}/{:.2} USDT，无浮盈，暂停加仓", total_margin, max_margin);
                return 0.0;
            }

            // 只用浮盈加仓
            let rolling_profit = unrealized_pnl * (self.rolling_config.roll_profit_ratio / 100.0);
            let profit_margin_per_grid = rolling_profit / self.grid_config.grid_count as f64;
            let extra_qty = self.calculate_quantity_from_margin(profit_margin_per_grid, order_price);

            info!("已达最大保证金 {:.2}/{:.2} USDT，只用浮盈加仓: {:.4}",
                  total_margin, max_margin, extra_qty);

            return extra_qty;
        }

        // 情况2: 未达最大保证金，正常计算
        if !has_profit {
            // 没有浮盈，使用基础保证金
            return self.calculate_quantity_from_margin(base_margin, order_price);
        }

        // 使用浮盈滚仓: 基础保证金 + 浮盈分摊
        let rolling_profit = unrealized_pnl * (self.rolling_config.roll_profit_ratio / 100.0);
        let profit_margin_per_grid = rolling_profit / self.grid_config.grid_count as f64;
        let total_order_margin = base_margin + profit_margin_per_grid;
        let new_qty = self.calculate_quantity_from_margin(total_order_margin, order_price);

        info!("滚仓计算: 保证金={:.2}/{:.2}, 浮盈={:.2}, 基础={:.2}, 滚仓加={:.2}, 数量={:.4}",
              total_margin, max_margin, unrealized_pnl, base_margin, profit_margin_per_grid, new_qty);

        new_qty
    }

    /// 检查并补充订单（价格跟随逻辑）
    /// 做多: 价格上涨时，在下方补买单
    /// 做空: 价格下跌时，在上方补卖单
    /// 返回: (需要下的新订单, 需要撤销的订单ID列表)
    pub async fn check_and_supplement_orders(&self, current_price: f64)
        -> (Vec<GridOrderAction>, Vec<(i64, String)>) {

        let orders = self.orders.read().await;
        let active_orders: Vec<&ActiveOrder> = orders.values().collect();

        let mut new_orders = Vec::new();
        let mut orders_to_cancel = Vec::new();

        // 检查是否接近目标价位，如果是则停止滚仓
        let target_price = self.rolling_config.target_price;
        let stop_distance = self.rolling_config.stop_roll_distance;
        if target_price > 0.0 {
            let is_long = self.is_long();
            let should_stop = if is_long {
                // 做多：价格达到 target * (1 - distance%) 时停止
                let stop_price = target_price * (1.0 - stop_distance / 100.0);
                current_price >= stop_price
            } else {
                // 做空：价格达到 target * (1 + distance%) 时停止
                let stop_price = target_price * (1.0 + stop_distance / 100.0);
                current_price <= stop_price
            };

            if should_stop {
                let stop_price = if is_long {
                    target_price * (1.0 - stop_distance / 100.0)
                } else {
                    target_price * (1.0 + stop_distance / 100.0)
                };
                info!("价格接近目标价位，停止滚仓: 当前价={:.2}, 目标价={:.2}, 停止价={:.2}",
                      current_price, target_price, stop_price);
                return (new_orders, orders_to_cancel);
            }
        }

        // 检查是否达到开始补单的盈利条件
        let start_distance = self.rolling_config.start_roll_distance;
        if start_distance > 0.0 {
            let pos = self.position.read().await;
            // 如果没有持仓信息，无法判断盈利，暂不补单
            if pos.quantity <= 0.0 || pos.entry_price <= 0.0 {
                debug!("未达开始补单条件: 持仓信息未就绪");
                return (new_orders, orders_to_cancel);
            }

            let is_long = self.is_long();
            let profit_percent = if is_long {
                // 做多: 盈利% = (现价 - 均价) / 均价 * 100
                (current_price - pos.entry_price) / pos.entry_price * 100.0
            } else {
                // 做空: 盈利% = (均价 - 现价) / 均价 * 100
                (pos.entry_price - current_price) / pos.entry_price * 100.0
            };

            if profit_percent < start_distance {
                debug!("未达开始补单条件: 当前盈利={:.2}%, 需要盈利={:.1}%",
                       profit_percent, start_distance);
                return (new_orders, orders_to_cancel);
            }
        }

        let spacing = self.grid_config.grid_spacing;
        let is_long = self.is_long();

        // 1. 检查价格附近是否有订单覆盖
        let (range_min, range_max) = if is_long {
            // 做多：检查价格下方 0.5-1.5 格范围
            (current_price - 1.5 * spacing, current_price - 0.5 * spacing)
        } else {
            // 做空：检查价格上方 0.5-1.5 格范围
            (current_price + 0.5 * spacing, current_price + 1.5 * spacing)
        };

        let has_coverage = active_orders.iter()
            .any(|o| o.price >= range_min && o.price <= range_max);

        if !has_coverage {
            // 价格附近没有订单，需要补单
            let base_price = *self.base_price.read().await;
            let supplement_target = if is_long {
                current_price - spacing
            } else {
                current_price + spacing
            };
            let offset = ((supplement_target - base_price) / spacing).round() as i32;
            let new_price = Self::round_price(
                base_price + offset as f64 * spacing,
                self.grid_config.price_precision,
            );

            // 检查该价格是否已有订单（防止重复）
            let has_order_at_price = active_orders.iter()
                .any(|o| (o.price - new_price).abs() < 0.01);

            if !has_order_at_price {
                // 计算滚仓后的订单大小
                let order_size = self.calculate_rolling_order_size(new_price).await;

                // 如果订单大小为0（达到最大保证金且无浮盈），不补单
                if order_size > 0.0 {
                    let direction_str = if is_long { "价格上涨" } else { "价格下跌" };
                    info!("{}，补单跟随: 当前价={:.2}, 补单价={:.2}, 数量={:.4}",
                          direction_str, current_price, new_price, order_size);

                    new_orders.push(GridOrderAction {
                        price: new_price,
                        quantity: order_size,
                        client_order_id: self.generate_client_order_id(new_price),
                        is_buy: is_long,
                    });
                }
            }
        }

        // 2. 检查订单总数是否超过限制
        let max_grid = self.grid_config.grid_count as usize;
        if active_orders.len() + new_orders.len() > max_grid {
            // 找出远离当前价的订单撤销
            let mut sorted_orders: Vec<_> = active_orders.iter().collect();
            if is_long {
                // 做多：撤销价格最低的（离当前价最远）
                sorted_orders.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap());
            } else {
                // 做空：撤销价格最高的（离当前价最远）
                sorted_orders.sort_by(|a, b| b.price.partial_cmp(&a.price).unwrap());
            }

            let to_cancel_count = (active_orders.len() + new_orders.len()).saturating_sub(max_grid);
            for order in sorted_orders.iter().take(to_cancel_count) {
                orders_to_cancel.push((order.order_id, order.client_order_id.clone()));
                info!("订单数超限，撤销远离价订单: {} @ {:.2}", order.client_order_id, order.price);
            }
        }

        drop(orders);

        // 3. 检查订单数量是否不足，需要补充
        let current_count = {
            let orders = self.orders.read().await;
            orders.len()
        };

        if current_count < self.grid_config.grid_count as usize {
            let missing = self.grid_config.grid_count as usize - current_count - new_orders.len();
            if missing > 0 {
                let orders = self.orders.read().await;

                // 找到当前边缘价订单
                let edge_price = if is_long {
                    // 做多：找最低价
                    orders.values()
                        .map(|o| o.price)
                        .min_by(|a, b| a.partial_cmp(b).unwrap())
                        .unwrap_or(current_price - spacing)
                } else {
                    // 做空：找最高价
                    orders.values()
                        .map(|o| o.price)
                        .max_by(|a, b| a.partial_cmp(b).unwrap())
                        .unwrap_or(current_price + spacing)
                };

                drop(orders);

                let base_price = *self.base_price.read().await;
                let edge_offset = ((edge_price - base_price) / spacing).round() as i32;

                for i in 1..=missing {
                    let new_offset = if is_long {
                        edge_offset - i as i32  // 做多：往下补
                    } else {
                        edge_offset + i as i32  // 做空：往上补
                    };
                    let new_price = Self::round_price(
                        base_price + new_offset as f64 * spacing,
                        self.grid_config.price_precision,
                    );

                    // 检查是否已有该价格的订单
                    let already_exists = new_orders.iter().any(|o| (o.price - new_price).abs() < 0.01);
                    if !already_exists {
                        // 计算该价格的订单数量
                        let order_qty = self.calculate_rolling_order_size(new_price).await;
                        if order_qty > 0.0 {
                            new_orders.push(GridOrderAction {
                                price: new_price,
                                quantity: order_qty,
                                client_order_id: self.generate_client_order_id(new_price),
                                is_buy: is_long,
                            });
                        }
                    }
                }

                if !new_orders.is_empty() {
                    let order_type = if is_long { "买单" } else { "卖单" };
                    info!("{}不足，补充{}个", order_type, new_orders.len());
                }
            }
        }

        (new_orders, orders_to_cancel)
    }

    /// 计算止盈单（使用目标价位作为止盈价）
    /// 做多: 卖出止盈（价格上涨到目标价）
    /// 做空: 买入止盈（价格下跌到目标价）
    pub async fn calculate_take_profit(&self) -> Option<CloseOrderAction> {
        let pos = self.position.read().await;

        if pos.quantity <= 0.0 {
            return None;
        }

        // 使用目标价位作为止盈价
        let tp_price = Self::round_price(
            self.rolling_config.target_price,
            self.grid_config.price_precision,
        );

        let is_long = self.is_long();
        let client_order_id = format!("roll_tp_{}", chrono::Utc::now().timestamp_millis());

        let direction_str = if is_long { "做多" } else { "做空" };
        info!("计算止盈({}): 持仓={:.4}, 均价={:.2}, 目标止盈价={:.2}",
              direction_str, pos.quantity, pos.entry_price, tp_price);

        Some(CloseOrderAction {
            price: tp_price,
            quantity: pos.quantity,
            client_order_id,
            is_buy: !is_long,  // 做多=卖出止盈, 做空=买入止盈
        })
    }

    /// 计算止损单（基于持仓均价）
    /// 做多: 卖出止损（价格下跌）
    /// 做空: 买入止损（价格上涨）
    pub async fn calculate_stop_loss(&self) -> Option<CloseOrderAction> {
        if self.rolling_config.stop_loss_percent <= 0.0 {
            return None;
        }

        let pos = self.position.read().await;

        if pos.quantity <= 0.0 {
            return None;
        }

        let is_long = self.is_long();
        let sl_price = if is_long {
            // 做多：价格下跌止损
            Self::round_price(
                pos.entry_price * (1.0 - self.rolling_config.stop_loss_percent / 100.0),
                self.grid_config.price_precision,
            )
        } else {
            // 做空：价格上涨止损
            Self::round_price(
                pos.entry_price * (1.0 + self.rolling_config.stop_loss_percent / 100.0),
                self.grid_config.price_precision,
            )
        };

        let client_order_id = format!("roll_sl_{}", chrono::Utc::now().timestamp_millis());

        let direction_str = if is_long { "做多" } else { "做空" };
        info!("计算止损({}): 持仓={:.4} ETH, 均价={:.2}, 止损价={:.2} ({:.1}%)",
              direction_str, pos.quantity, pos.entry_price, sl_price, self.rolling_config.stop_loss_percent);

        Some(CloseOrderAction {
            price: sl_price,
            quantity: pos.quantity,
            client_order_id,
            is_buy: !is_long,  // 做多=卖出止损, 做空=买入止损
        })
    }

    /// 止盈/止损成交：清空持仓
    pub async fn on_close_filled(&self, filled_price: f64) {
        let mut pos = self.position.write().await;
        let pnl = (filled_price - pos.entry_price) * pos.quantity;

        info!("平仓成交: 价格={:.2}, 持仓={:.4}, 盈亏={:.2} USDT",
              filled_price, pos.quantity, pnl);

        // 清空持仓
        *pos = Position::default();

        // 清空止盈止损单ID
        *self.take_profit_order_id.write().await = None;
        *self.stop_loss_order_id.write().await = None;
    }

    /// 更新持仓信息（从交易所同步）
    /// 同时计算已用保证金用于 max_margin 检查
    pub async fn update_position(&self, quantity: f64, entry_price: f64, unrealized_pnl: f64) {
        let mut pos = self.position.write().await;
        pos.quantity = quantity;
        pos.entry_price = entry_price;
        pos.unrealized_pnl = unrealized_pnl;

        // 计算已用保证金: 持仓价值 / 杠杆
        let leverage = self.grid_config.leverage as f64;
        let position_value = quantity.abs() * entry_price;
        let used_margin = position_value / leverage;
        *self.total_margin.write().await = used_margin;

        info!("同步已用保证金: {:.2} USDT (持仓价值={:.2}, 杠杆={}x)",
              used_margin, position_value, self.grid_config.leverage);
    }

    /// 获取当前持仓
    pub async fn get_position(&self) -> Position {
        self.position.read().await.clone()
    }

    /// 设置止盈单 algo_id
    pub async fn set_take_profit_order_id(&self, algo_id: Option<i64>) {
        *self.take_profit_order_id.write().await = algo_id;
    }

    /// 获取止盈单 algo_id
    pub async fn get_take_profit_order_id(&self) -> Option<i64> {
        *self.take_profit_order_id.read().await
    }

    /// 设置止损单 algo_id
    pub async fn set_stop_loss_order_id(&self, algo_id: Option<i64>) {
        *self.stop_loss_order_id.write().await = algo_id;
    }

    /// 获取止损单 algo_id
    pub async fn get_stop_loss_order_id(&self) -> Option<i64> {
        *self.stop_loss_order_id.read().await
    }

    /// 获取统计信息
    pub async fn get_stats(&self) -> (usize, f64, f64) {
        let orders = self.orders.read().await;
        let pos = self.position.read().await;
        (orders.len(), pos.quantity, pos.entry_price)
    }

    /// 订单取消回调
    pub async fn on_order_cancelled(&self, client_order_id: &str) {
        self.orders.write().await.remove(client_order_id);
        debug!("订单已取消: {}", client_order_id);
    }

    /// 生成 clientOrderId
    /// 做多: roll_b_xxx (buy)
    /// 做空: roll_s_xxx (sell)
    fn generate_client_order_id(&self, price: f64) -> String {
        let ts = chrono::Utc::now().timestamp_millis();
        let prefix = if self.is_long() { "roll_b" } else { "roll_s" };
        format!("{}_{:.0}_{}", prefix, price * 100.0, ts % 1000000)
    }

    /// 价格四舍五入
    fn round_price(price: f64, precision: u32) -> f64 {
        let factor = 10_f64.powi(precision as i32);
        (price * factor).round() / factor
    }
}
