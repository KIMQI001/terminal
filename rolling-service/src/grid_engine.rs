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
    take_profit_order_id: Arc<RwLock<Option<String>>>,  // 当前止盈单ID
    stop_loss_order_id: Arc<RwLock<Option<String>>>,    // 当前止损单ID
    total_cost: Arc<RwLock<f64>>,           // 累计投入成本（用于计算浮盈）
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
            total_cost: Arc::new(RwLock::new(0.0)),
        }
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
    pub async fn initialize(&self, base_price: f64) -> Vec<GridOrderAction> {
        *self.base_price.write().await = base_price;

        let mut actions = Vec::new();
        let spacing = self.grid_config.grid_spacing;
        let is_long = self.is_long();

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

            let client_order_id = self.generate_client_order_id(price);

            actions.push(GridOrderAction {
                price,
                quantity: self.grid_config.order_size,
                client_order_id,
                is_buy: is_long,  // 做多=买单入场，做空=卖单入场
            });
        }

        let direction_str = if is_long { "做多" } else { "做空" };
        let order_type = if is_long { "买单" } else { "卖单" };
        info!("初始化网格({}): 基准价={}, 创建{}个{}, 每单{} ETH",
              direction_str, base_price, actions.len(), order_type, self.grid_config.order_size);
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

        // 累计投入成本
        *self.total_cost.write().await += new_cost;

        let direction_str = if self.is_long() { "买单" } else { "卖单" };
        info!("{}成交: {} @ {}, 持仓更新: {:.4} -> {:.4} ETH, 均价: {:.2}",
              direction_str, filled_qty, filled_price, old_qty, pos.quantity, pos.entry_price);

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

    /// 计算滚仓后的订单大小（基于浮盈，平均分配到每个网格）
    /// 如果设置了 max_position 且已达到，则只用浮盈加仓
    pub async fn calculate_rolling_order_size(&self) -> f64 {
        let pos = self.position.read().await;
        let current_position = pos.quantity;
        drop(pos);

        let max_position = self.rolling_config.max_position;
        let base_order_size = self.grid_config.order_size;

        // 检查是否达到最大仓位
        let reached_max = max_position > 0.0 && current_position >= max_position;

        // 计算浮盈部分
        let unrealized_pnl = self.calculate_unrealized_pnl().await;
        let has_profit = unrealized_pnl > 0.0 && self.rolling_config.use_rolling_margin;

        // 情况1: 达到最大仓位
        if reached_max {
            if !has_profit {
                // 没有浮盈，不能加仓
                info!("已达最大仓位 {:.4}/{:.4} ETH，无浮盈，暂停加仓", current_position, max_position);
                return 0.0;
            }

            // 只用浮盈加仓
            let rolling_profit = unrealized_pnl * (self.rolling_config.roll_profit_ratio / 100.0);
            let profit_per_grid = rolling_profit / self.grid_config.grid_count as f64;
            let current_price = *self.current_price.read().await;
            let leverage = self.grid_config.leverage as f64;
            let extra_qty = profit_per_grid * leverage / current_price;

            let factor = 10_f64.powi(self.grid_config.quantity_precision as i32);
            let rounded_size = (extra_qty * factor).round() / factor;

            info!("已达最大仓位 {:.4}/{:.4} ETH，只用浮盈加仓: {:.4} ETH",
                  current_position, max_position, rounded_size);

            return rounded_size;
        }

        // 情况2: 未达最大仓位，正常计算
        if !has_profit {
            // 没有浮盈，使用基础订单大小
            return base_order_size;
        }

        // 使用浮盈滚仓
        let rolling_profit = unrealized_pnl * (self.rolling_config.roll_profit_ratio / 100.0);
        let profit_per_grid = rolling_profit / self.grid_config.grid_count as f64;
        let current_price = *self.current_price.read().await;
        let leverage = self.grid_config.leverage as f64;
        let extra_qty = profit_per_grid * leverage / current_price;
        let new_size = base_order_size + extra_qty;

        let factor = 10_f64.powi(self.grid_config.quantity_precision as i32);
        let rounded_size = (new_size * factor).round() / factor;

        info!("滚仓计算: 仓位={:.4}/{:.4}, 浮盈={:.2}, 分{}份每份={:.2}, 基础={:.4}, 新增={:.4}, 总={:.4}",
              current_position, max_position, unrealized_pnl, self.grid_config.grid_count,
              profit_per_grid, base_order_size, extra_qty, rounded_size);

        rounded_size
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

        // 计算滚仓后的订单大小
        let order_size = self.calculate_rolling_order_size().await;

        // 如果订单大小为0（达到最大仓位且无浮盈），不补单
        if order_size <= 0.0 {
            return (new_orders, orders_to_cancel);
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
            let target_price = if is_long {
                current_price - spacing
            } else {
                current_price + spacing
            };
            let offset = ((target_price - base_price) / spacing).round() as i32;
            let new_price = Self::round_price(
                base_price + offset as f64 * spacing,
                self.grid_config.price_precision,
            );

            // 检查该价格是否已有订单（防止重复）
            let has_order_at_price = active_orders.iter()
                .any(|o| (o.price - new_price).abs() < 0.01);

            if !has_order_at_price {
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
                        new_orders.push(GridOrderAction {
                            price: new_price,
                            quantity: order_size,
                            client_order_id: self.generate_client_order_id(new_price),
                            is_buy: is_long,
                        });
                    }
                }

                if !new_orders.is_empty() {
                    let order_type = if is_long { "买单" } else { "卖单" };
                    info!("{}不足，补充{}个，每单{:.4}", order_type, missing, order_size);
                }
            }
        }

        (new_orders, orders_to_cancel)
    }

    /// 计算止盈单（基于持仓均价）
    /// 做多: 卖出止盈（价格上涨）
    /// 做空: 买入止盈（价格下跌）
    pub async fn calculate_take_profit(&self) -> Option<CloseOrderAction> {
        let pos = self.position.read().await;

        if pos.quantity <= 0.0 {
            return None;
        }

        let is_long = self.is_long();
        let tp_price = if is_long {
            // 做多：价格上涨止盈
            Self::round_price(
                pos.entry_price * (1.0 + self.rolling_config.take_profit_percent / 100.0),
                self.grid_config.price_precision,
            )
        } else {
            // 做空：价格下跌止盈
            Self::round_price(
                pos.entry_price * (1.0 - self.rolling_config.take_profit_percent / 100.0),
                self.grid_config.price_precision,
            )
        };

        let client_order_id = format!("roll_tp_{}", chrono::Utc::now().timestamp_millis());

        let direction_str = if is_long { "做多" } else { "做空" };
        info!("计算止盈({}): 持仓={:.4} ETH, 均价={:.2}, 止盈价={:.2} ({:.1}%)",
              direction_str, pos.quantity, pos.entry_price, tp_price, self.rolling_config.take_profit_percent);

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
    pub async fn update_position(&self, quantity: f64, entry_price: f64, unrealized_pnl: f64) {
        let mut pos = self.position.write().await;
        pos.quantity = quantity;
        pos.entry_price = entry_price;
        pos.unrealized_pnl = unrealized_pnl;
    }

    /// 获取当前持仓
    pub async fn get_position(&self) -> Position {
        self.position.read().await.clone()
    }

    /// 设置止盈单ID
    pub async fn set_take_profit_order_id(&self, order_id: Option<String>) {
        *self.take_profit_order_id.write().await = order_id;
    }

    /// 获取止盈单ID
    pub async fn get_take_profit_order_id(&self) -> Option<String> {
        self.take_profit_order_id.read().await.clone()
    }

    /// 设置止损单ID
    pub async fn set_stop_loss_order_id(&self, order_id: Option<String>) {
        *self.stop_loss_order_id.write().await = order_id;
    }

    /// 获取止损单ID
    pub async fn get_stop_loss_order_id(&self) -> Option<String> {
        self.stop_loss_order_id.read().await.clone()
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
