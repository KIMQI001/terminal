/**
 * 策略状态机
 *
 * 规则(用户定义):
 * - 框架建立 = 6 个价位里**至少一个**已被触发(红框逻辑:波段 HH/LL 之后被 K 线遮挡)
 * - 框架建立后 → 给**其余未触发**的价位挂单(阶梯)
 * - 止损 200 点 / 止盈 1000 点(绝对点数)
 * - 一旦有持仓 → 撤掉其余挂单,只留止盈止损
 * - 下单量按余额比例:总保证金 = 余额 × margin_pct,平均分给阶梯上的每一档
 */

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::binance::{BinanceApi, OrderResult};
use crate::detector::compute_frame;
use crate::kline::{default_limit, fetch_klines};
use crate::types::{
    Frame, Level, PlacedOrder, PositionInfo, Side, StrategyConfig, StrategyState, StrategyStatus,
};

// 入场单 clientOrderId 前缀(止盈止损用别的前缀,避免被一起撤掉)
pub const ENTRY_PREFIX: &str = "llr_e";
pub const SL_PREFIX: &str = "llr_sl";
pub const TP_PREFIX: &str = "llr_tp";

/// 运行期状态
pub struct Runtime {
    pub config: Option<StrategyConfig>,
    pub api: Option<Arc<BinanceApi>>,
    pub running: bool,
    pub state: StrategyState,
    pub frame: Option<Frame>,
    pub orders: Vec<PlacedOrder>,
    pub position: Option<PositionInfo>,
    pub current_price: Option<f64>,
    pub balance: Option<f64>,
    pub leverage: Option<u32>,
    /// 建立框架时的波段标识(HH 时间, LL 时间)
    pub armed_leg: Option<(i64, i64)>,
    /// 建立框架时已触发的价位标签(用于判断是否有**新的**触发)
    pub armed_covered: Vec<String>,
    /// 是否已挂出阶梯
    pub armed: bool,
    pub last_error: Option<String>,
    pub updated_at: i64,
}

impl Runtime {
    pub fn new() -> Self {
        Self {
            config: None,
            api: None,
            running: false,
            state: StrategyState::Idle,
            frame: None,
            orders: Vec::new(),
            position: None,
            current_price: None,
            balance: None,
            leverage: None,
            armed_leg: None,
            armed_covered: Vec::new(),
            armed: false,
            last_error: None,
            updated_at: now_sec(),
        }
    }

    pub fn status(&self) -> StrategyStatus {
        let cfg = self.config.as_ref();
        StrategyStatus {
            state: self.state,
            running: self.running,
            symbol: cfg.map(|c| c.symbol.clone()).unwrap_or_default(),
            timeframe: cfg.map(|c| c.timeframe.clone()).unwrap_or_default(),
            exchange: cfg.map(|c| c.exchange.clone()).unwrap_or_default(),
            user_id: cfg.map(|c| c.user_id).unwrap_or(0),
            dry_run: cfg.map(|c| c.dry_run).unwrap_or(true),
            margin_pct: cfg.map(|c| c.margin_pct).unwrap_or(0.375),
            sl_points: cfg.map(|c| c.sl_points).unwrap_or(200.0),
            tp_points: cfg.map(|c| c.tp_points).unwrap_or(1000.0),
            current_price: self.current_price,
            balance: self.balance,
            leverage: self.leverage,
            armed_leg: self.armed_leg,
            frame: self.frame.clone(),
            orders: self.orders.clone(),
            position: self.position.clone(),
            last_error: self.last_error.clone(),
            updated_at: self.updated_at,
        }
    }
}

/// 引擎:后台轮询 K 线 + 维护状态机
pub struct Engine {
    pub rt: Arc<Mutex<Runtime>>,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            rt: Arc::new(Mutex::new(Runtime::new())),
        }
    }

    /// 设置 / 更新配置(会自动重启策略)
    pub async fn configure(&self, cfg: StrategyConfig) {
        let mut rt = self.rt.lock().await;
        // 配置变了 → 先把旧的挂单撤掉
        if let (Some(old_api), Some(old_cfg)) = (rt.api.as_ref(), rt.config.as_ref()) {
            if old_cfg.symbol != cfg.symbol {
                let _ = old_api.cancel_orders_by_prefix(&old_cfg.symbol, ENTRY_PREFIX).await;
            }
        }
        rt.armed = false;
        rt.armed_leg = None;
        rt.armed_covered.clear();
        rt.orders.clear();
        rt.position = None;
        rt.state = StrategyState::Waiting;
        rt.last_error = None;
        rt.running = true;
        rt.api = Some(Arc::new(BinanceApi::new(
            &cfg.api_key,
            &cfg.api_secret,
            cfg.is_testnet,
        )));
        rt.config = Some(cfg);
        info!("[Strategy] 配置已更新,策略启动(dry_run={})", rt.config.as_ref().map(|c| c.dry_run).unwrap_or(true));
    }

    /// 停止策略:撤掉自己挂的单,状态置为 Stopped
    pub async fn stop(&self) {
        let mut rt = self.rt.lock().await;
        if let (Some(api), Some(cfg)) = (rt.api.clone(), rt.config.clone()) {
            if let Ok(n) = api.cancel_orders_by_prefix(&cfg.symbol, ENTRY_PREFIX).await {
                info!("[Strategy] 停止:撤掉 {} 个入场挂单", n);
            }
        }
        rt.running = false;
        rt.state = StrategyState::Stopped;
        rt.armed = false;
        rt.orders.clear();
    }

    /// 主循环
    pub async fn run(self: Arc<Self>) {
        loop {
            let (running, interval) = {
                let rt = self.rt.lock().await;
                (
                    rt.running,
                    rt.config.as_ref().map(|c| c.poll_interval_sec).unwrap_or(5),
                )
            };
            if running {
                if let Err(e) = self.tick().await {
                    error!("[Strategy] tick 失败: {}", e);
                    let mut rt = self.rt.lock().await;
                    rt.last_error = Some(e.to_string());
                }
            }
            tokio::time::sleep(Duration::from_secs(interval.max(1))).await;
        }
    }

    /// 一轮:抓 K 线 → 算框架 → 看仓 → 挂/撤单
    async fn tick(self: &Arc<Self>) -> anyhow::Result<()> {
        let (cfg, api) = {
            let rt = self.rt.lock().await;
            match (rt.config.clone(), rt.api.clone()) {
                (Some(c), Some(a)) => (c, a),
                _ => return Ok(()),
            }
        };

        // —— 1. K 线 & 框架 ——
        let candles = fetch_klines(&cfg.symbol, &cfg.timeframe, default_limit(&cfg.symbol)).await?;
        let frame = compute_frame(&candles, &cfg.timeframe);
        let last_close = candles.last().map(|c| c.close);

        // —— 2. 账户信息 ——
        let price = api
            .get_price(&cfg.symbol)
            .await
            .ok()
            .or(last_close);
        let leverage = api.get_leverage(&cfg.symbol).await.ok().or(Some(cfg.leverage));
        let balance = api.get_balance().await.ok();
        let hedge_mode = api.is_hedge_mode().await.unwrap_or(true);
        let positions = api.get_positions(&cfg.symbol).await.unwrap_or_default();

        {
            let mut rt = self.rt.lock().await;
            rt.frame = frame.clone();
            rt.current_price = price;
            rt.balance = balance;
            rt.leverage = leverage;
            rt.updated_at = now_sec();
        }

        // —— 3. 有持仓 → 撤掉其余挂单,只留止盈止损 ——
        let my_positions: Vec<_> = positions
            .into_iter()
            .filter(|p| p.position_amt.abs() > 1e-9)
            .collect();

        if !my_positions.is_empty() {
            let pos = &my_positions[0];
            {
                let mut rt = self.rt.lock().await;
                rt.state = StrategyState::InPosition;
                rt.position = Some(PositionInfo {
                    position_side: pos.position_side.clone(),
                    amount: pos.position_amt,
                    entry_price: pos.entry_price,
                    quantity: pos.position_amt.abs(),
                });
                rt.armed = false;
                rt.orders.clear(); // 入场挂单已撤,列表同步清空
            }
            // 撤掉所有入场挂单(只有确实还挂着才撤,省掉无谓的接口调用)
            let live = api.get_open_orders(&cfg.symbol).await.unwrap_or_default();
            let live_algo = api.get_open_algo_orders(&cfg.symbol).await.unwrap_or_default();
            let entry_count = live
                .iter()
                .filter(|o| o.client_order_id.starts_with(ENTRY_PREFIX))
                .count()
                + live_algo
                    .iter()
                    .filter(|o| o.client_algo_id.starts_with(ENTRY_PREFIX))
                    .count();
            if entry_count > 0 {
                match api.cancel_orders_by_prefix(&cfg.symbol, ENTRY_PREFIX).await {
                    Ok(n) if n > 0 => info!("[Strategy] 已有持仓,撤掉 {} 个入场挂单", n),
                    Ok(_) => {}
                    Err(e) => warn!("[Strategy] 撤入场挂单失败: {}", e),
                }
            }
            // 撤掉方向不符的保护单(多空反手时残留的旧保护单,留着会误平新仓)
            for a in live_algo.iter() {
                let is_protective = a.client_algo_id.starts_with(SL_PREFIX)
                    || a.client_algo_id.starts_with(TP_PREFIX);
                if !is_protective || a.position_side == pos.position_side {
                    continue;
                }
                warn!(
                    "[Strategy] 撤掉方向不符的保护单 algoId={}({} → 当前 {})",
                    a.algo_id, a.position_side, pos.position_side
                );
                if let Ok(r) = api.cancel_algo_order(&cfg.symbol, a.algo_id).await {
                    if !r.success {
                        warn!(
                            "[Strategy] 撤保护单失败 algoId={}: {}",
                            a.algo_id,
                            r.error.unwrap_or_else(|| "未知错误".into())
                        );
                    }
                }
            }

            // 确保止盈止损都在
            self.ensure_protective_orders(&cfg, &api, pos, hedge_mode, &live_algo, price)
                .await;
            return Ok(());
        }

        // 无持仓
        {
            let mut rt = self.rt.lock().await;
            rt.position = None;
        }

        // —— 3.5 仓位没了但保护单还挂着 → 撤掉(否则残留的条件单会反向开仓) ——
        {
            let live_algo = api.get_open_algo_orders(&cfg.symbol).await.unwrap_or_default();
            let orphan = live_algo
                .iter()
                .filter(|o| {
                    o.client_algo_id.starts_with(SL_PREFIX) || o.client_algo_id.starts_with(TP_PREFIX)
                })
                .count();
            if orphan > 0 {
                for p in [SL_PREFIX, TP_PREFIX] {
                    match api.cancel_orders_by_prefix(&cfg.symbol, p).await {
                        Ok(n) if n > 0 => {
                            warn!("[Strategy] 已无持仓,撤掉 {} 个残留保护单({})", n, p)
                        }
                        _ => {}
                    }
                }
            }
        }

        let Some(frame) = frame else {
            let mut rt = self.rt.lock().await;
            rt.state = StrategyState::Waiting;
            return Ok(());
        };

        // —— 4. 波段变了 → 撤掉旧挂单,重新开始 ——
        let sig = frame.leg_signature();
        {
            let mut rt = self.rt.lock().await;
            if rt.armed_leg != Some(sig) {
                if rt.armed_leg.is_some() {
                    info!("[Strategy] 波段变了({:?} → {:?}),撤掉旧挂单", rt.armed_leg, sig);
                    match api.cancel_orders_by_prefix(&cfg.symbol, ENTRY_PREFIX).await {
                        Ok(n) => info!("[Strategy] 撤掉 {} 个旧挂单", n),
                        Err(e) => warn!("[Strategy] 撤旧挂单失败: {}", e),
                    }
                }
                rt.armed_leg = Some(sig);
                rt.armed = false;
                rt.armed_covered.clear();
                rt.orders.clear();
            }
        }

        // —— 5. 框架是否成立 ——
        if !frame.is_established() {
            let mut rt = self.rt.lock().await;
            rt.state = StrategyState::Waiting;
            return Ok(());
        }

        // —— 6. 已挂过 → 检查挂单是否还在 ——
        let armed = self.rt.lock().await.armed;
        if armed {
            // dry run 下挂单根本不存在交易所,跳过这个检查,保持 armed 状态
            if !cfg.dry_run {
                let live = api.get_open_orders(&cfg.symbol).await.unwrap_or_default();
                let ours = live
                    .iter()
                    .filter(|o| o.client_order_id.starts_with(ENTRY_PREFIX))
                    .count();
                let live_algo = api.get_open_algo_orders(&cfg.symbol).await.unwrap_or_default();
                let ours_algo = live_algo
                    .iter()
                    .filter(|o| o.client_algo_id.starts_with(ENTRY_PREFIX))
                    .count();
                if ours == 0 && ours_algo == 0 {
                    // 挂单没了(成交后已平 / 被外部撤掉)→ 等待**新的**触发再重新建仓
                    info!("[Strategy] 入场挂单已不在,等待新的触发");
                    let mut rt = self.rt.lock().await;
                    rt.armed = false;
                    rt.orders.clear();
                    rt.state = StrategyState::Waiting;
                }
            }
            return Ok(());
        }

        // —— 7. 是否允许建仓(需要一个新的触发) ——
        let covered_labels: Vec<String> = frame
            .covered_levels()
            .iter()
            .map(|l| l.label.clone())
            .collect();
        let armed_covered = self.rt.lock().await.armed_covered.clone();
        let has_new_trigger = covered_labels
            .iter()
            .any(|l| !armed_covered.contains(l));
        let first_arm = armed_covered.is_empty();
        if !(first_arm || has_new_trigger) {
            let mut rt = self.rt.lock().await;
            rt.state = StrategyState::Waiting;
            return Ok(());
        }

        // —— 8. 建立框架 → 给未触发的价位挂单 ——
        let levels: Vec<Level> = frame.uncovered_levels().into_iter().cloned().collect();
        if levels.is_empty() {
            let mut rt = self.rt.lock().await;
            rt.armed = true;
            rt.armed_covered = covered_labels;
            rt.state = StrategyState::Armed;
            return Ok(());
        }

        let balance = balance.unwrap_or(0.0);
        let leverage = leverage.unwrap_or(cfg.leverage).max(1) as f64;
        let placed = self
            .place_entry_orders(&cfg, &api, &frame, &levels, price, balance, leverage, hedge_mode)
            .await;

        let mut rt = self.rt.lock().await;
        rt.armed = true;
        rt.armed_covered = covered_labels;
        rt.orders = placed;
        rt.state = StrategyState::Armed;
        info!(
            "[Strategy] 框架成立,已挂 {} 个入场单(balance={:.2} margin_pct={} lev={})",
            rt.orders.len(),
            balance,
            cfg.margin_pct,
            leverage
        );
        Ok(())
    }

    /// 给未触发的价位挂入场单
    #[allow(clippy::too_many_arguments)]
    async fn place_entry_orders(
        &self,
        cfg: &StrategyConfig,
        api: &BinanceApi,
        frame: &Frame,
        levels: &[Level],
        price: Option<f64>,
        balance: f64,
        leverage: f64,
        hedge_mode: bool,
    ) -> Vec<PlacedOrder> {
        let mut placed = Vec::new();
        let n = levels.len() as f64;
        // 总保证金预算 = 余额 × margin_pct,平均分给每一档
        let per_margin = balance * cfg.margin_pct / n;
        let (hh_t, ll_t) = frame.leg_signature();
        let cur_price = price.unwrap_or(0.0);

        for (i, level) in levels.iter().enumerate() {
            let qty_raw = if level.price > 0.0 {
                per_margin * leverage / level.price
            } else {
                0.0
            };
            let qty = round_qty(qty_raw, &cfg.symbol);
            // dry run 下拿不到余额时,数量算不出来也照样把计划打出来(真实下单则跳过)
            let (qty, qty_note) = if qty <= 0.0 {
                if cfg.dry_run {
                    (qty_raw, " [余额不可用,数量未取整]")
                } else {
                    warn!("[Strategy] {} {} 数量为 0,跳过", level.label, level.price);
                    continue;
                }
            } else {
                (qty, "")
            };

            let side_str = match level.side {
                Side::Buy => "BUY",
                Side::Sell => "SELL",
            };

            // 防御:价位已经被价格越过去 → 限价单会**立刻成交**(等于市价追单),跳过并告警。
            // 正常情况下「已触发」判定会先把这些价位排除掉,走到这里说明数据与现价不一致。
            if cur_price > 0.0 {
                let crossed = match level.side {
                    Side::Sell => level.price < cur_price,
                    Side::Buy => level.price > cur_price,
                };
                if crossed {
                    warn!(
                        "[Strategy] {} {} 价位 {} 已在现价 {:.1} 的另一侧,跳过(避免立刻成交)",
                        level.label, side_str, level.price, cur_price
                    );
                    continue;
                }
            }

            let position_side = if hedge_mode {
                match level.side {
                    Side::Buy => "LONG",
                    Side::Sell => "SHORT",
                }
            } else {
                "BOTH"
            };

            // 挂单类型:价位在现价"上方"就用 STOP(等价格涨到该价位再成交),
            // 在"下方"就用 LIMIT(等价格回落下来成交)
            let above = cur_price > 0.0 && level.price > cur_price;
            let client_id = format!("llr_e{}x{}x{}", hh_t, ll_t, i);

            let res: anyhow::Result<OrderResult> = if cfg.dry_run {
                info!(
                    "[Strategy] [DRY] {} {} {} @{} qty={}{}",
                    client_id, side_str, position_side, level.price, qty, qty_note
                );
                Ok(OrderResult {
                    success: true,
                    client_order_id: Some(client_id.clone()),
                    ..Default::default()
                })
            } else if above {
                api.place_algo_order(
                    &cfg.symbol,
                    side_str,
                    position_side,
                    "STOP_MARKET",
                    level.price,
                    qty,
                    &client_id,
                    false,
                )
                .await
            } else {
                api.place_limit_order(
                    &cfg.symbol,
                    side_str,
                    position_side,
                    qty,
                    level.price,
                    &client_id,
                    false,
                )
                .await
            };

            match res {
                Ok(r) if r.success => {
                    info!(
                        "[Strategy] 挂单成功 {} {} {} @{} qty={} ({})",
                        client_id, side_str, position_side, level.price, qty, level.label
                    );
                    placed.push(PlacedOrder {
                        client_order_id: client_id,
                        label: level.label.clone(),
                        price: level.price,
                        side: level.side,
                        quantity: qty,
                        order_type: if above { "STOP_MARKET" } else { "LIMIT" }.to_string(),
                        order_id: r.order_id.or(r.algo_id),
                    });
                }
                Ok(r) => {
                    let msg = r.error.clone().unwrap_or_else(|| "未知错误".into());
                    warn!("[Strategy] 挂单失败 {} {}: {}", client_id, level.label, msg);
                }
                Err(e) => {
                    warn!("[Strategy] 挂单异常 {} {}: {}", client_id, level.label, e);
                }
            }
        }
        placed
    }

    /// 确保止盈止损挂单都在(有持仓时)
    ///
    /// 三个要点:
    /// 1. 匹配保护单时**同时看前缀 + 持仓方向 + 买卖方向**,避免多空反手时把旧单当成"已挂"
    /// 2. 触发价方向必须合法(价格已经越过止损/止盈时 Binance 会拒单 -2021),
    ///    这时等价于"止损/止盈已触发" → 直接市价平仓
    /// 3. 拿不到现价时只做方向判断,不阻断挂单
    async fn ensure_protective_orders(
        &self,
        cfg: &StrategyConfig,
        api: &BinanceApi,
        pos: &crate::binance::Position,
        hedge_mode: bool,
        open_algos: &[crate::binance::AlgoOrder],
        current_price: Option<f64>,
    ) {
        let is_long = pos.position_amt > 0.0;
        let entry = pos.entry_price;
        if entry <= 0.0 {
            return;
        }
        // 平多:SL 在下、TP 在上;平空:反之
        let (sl_price, tp_price) = if is_long {
            (entry - cfg.sl_points, entry + cfg.tp_points)
        } else {
            (entry + cfg.sl_points, entry - cfg.tp_points)
        };
        let close_side = if is_long { "SELL" } else { "BUY" };
        let position_side = if hedge_mode {
            if is_long { "LONG" } else { "SHORT" }
        } else {
            "BOTH"
        };
        let qty = pos.position_amt.abs();

        // —— 触发价方向校验:价格已经越过止损/止盈 → 条件单挂不上,直接市价平 ——
        if let Some(cur) = current_price {
            if cur > 0.0 {
                if !validate_trigger_price(cur, sl_price, close_side, "STOP_MARKET") {
                    warn!(
                        "[Strategy] 现价 {:.2} 已越过止损价 {:.2}({}),条件单挂不上 → 市价平仓",
                        cur, sl_price, pos.position_side
                    );
                    self.market_close(api, &cfg.symbol, close_side, position_side, qty)
                        .await;
                    return;
                }
                if !validate_trigger_price(cur, tp_price, close_side, "TAKE_PROFIT_MARKET") {
                    warn!(
                        "[Strategy] 现价 {:.2} 已越过止盈价 {:.2}({}),条件单挂不上 → 市价平仓",
                        cur, tp_price, pos.position_side
                    );
                    self.market_close(api, &cfg.symbol, close_side, position_side, qty)
                        .await;
                    return;
                }
            }
        }

        let sl_prefix = format!("{}x{}_", SL_PREFIX, pos.position_side);
        let tp_prefix = format!("{}x{}_", TP_PREFIX, pos.position_side);
        // 交易所返回里 side 可能缺失(空串时不做方向判断,避免重复挂保护单)
        let has_sl = open_algos.iter().any(|o| {
            o.client_algo_id.starts_with(&sl_prefix) && (o.side.is_empty() || o.side == close_side)
        });
        let has_tp = open_algos.iter().any(|o| {
            o.client_algo_id.starts_with(&tp_prefix) && (o.side.is_empty() || o.side == close_side)
        });

        if !has_sl {
            let client_id = format!("{}x{}_{}", SL_PREFIX, pos.position_side, entry as i64);
            self.place_protective(
                cfg,
                api,
                &client_id,
                close_side,
                position_side,
                "STOP_MARKET",
                sl_price,
                qty,
            )
            .await;
        }
        if !has_tp {
            let client_id = format!("{}x{}_{}", TP_PREFIX, pos.position_side, entry as i64);
            self.place_protective(
                cfg,
                api,
                &client_id,
                close_side,
                position_side,
                "TAKE_PROFIT_MARKET",
                tp_price,
                qty,
            )
            .await;
        }
    }

    /// 市价平仓(止损/止盈价位已被价格越过去时的兜底)
    async fn market_close(
        &self,
        api: &BinanceApi,
        symbol: &str,
        side: &str,
        position_side: &str,
        qty: f64,
    ) {
        match api.place_market_order(symbol, side, position_side, qty).await {
            Ok(r) if r.success => info!(
                "[Strategy] 已市价平仓 {} {} qty={} orderId={:?}",
                symbol, side, qty, r.order_id
            ),
            Ok(r) => error!(
                "[Strategy] 市价平仓失败 {}: {}",
                symbol,
                r.error.unwrap_or_else(|| "未知错误".into())
            ),
            Err(e) => error!("[Strategy] 市价平仓异常 {}: {}", symbol, e),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn place_protective(
        &self,
        cfg: &StrategyConfig,
        api: &BinanceApi,
        client_id: &str,
        side: &str,
        position_side: &str,
        order_type: &str,
        price: f64,
        qty: f64,
    ) {
        if cfg.dry_run {
            info!(
                "[Strategy] [DRY] 保护单 {} {} {} {} @{} qty={}",
                client_id, side, position_side, order_type, price, qty
            );
            return;
        }
        match api
            .place_algo_order(
                &cfg.symbol,
                side,
                position_side,
                order_type,
                price,
                qty,
                client_id,
                true,
            )
            .await
        {
            Ok(r) if r.success => info!(
                "[Strategy] 保护单已挂 {} {} {} @{} qty={}",
                client_id, side, order_type, price, qty
            ),
            Ok(r) => warn!(
                "[Strategy] 保护单失败 {}: {}",
                client_id,
                r.error.unwrap_or_else(|| "未知错误".into())
            ),
            Err(e) => warn!("[Strategy] 保护单异常 {}: {}", client_id, e),
        }
    }
}

/// 校验保护单触发价方向(对齐 wick-sr-detector/src/order.rs 的 validate_stop_price)
///
/// - STOP_MARKET 平多(SELL):触发价必须 < 现价;平空(BUY):必须 > 现价
/// - TAKE_PROFIT_MARKET 平多(SELL):触发价必须 > 现价;平空(BUY):必须 < 现价
///
/// 方向不合法 = 价格已经越过了这一档,Binance 会以 -2021 拒单。
fn validate_trigger_price(current_price: f64, trigger: f64, side: &str, order_type: &str) -> bool {
    match order_type {
        "STOP_MARKET" => {
            if side == "SELL" {
                trigger < current_price
            } else {
                trigger > current_price
            }
        }
        "TAKE_PROFIT_MARKET" => {
            if side == "SELL" {
                trigger > current_price
            } else {
                trigger < current_price
            }
        }
        _ => true,
    }
}

/// 数量按精度取整(BTCUSDC 3 位 / ETHUSDC 3 位,默认 3 位)
fn round_qty(qty: f64, symbol: &str) -> f64 {
    let decimals = match symbol.to_uppercase().as_str() {
        "BTCUSDC" | "ETHUSDC" | "BTCUSDT" | "ETHUSDT" => 3,
        _ => 3,
    };
    let factor = 10f64.powi(decimals as i32);
    (qty * factor).floor() / factor
}

/// 当前时间(秒)
pub fn now_sec() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 止损触发价方向() {
        // 平多(SELL):止损必须在现价下方
        assert!(validate_trigger_price(100.0, 98.0, "SELL", "STOP_MARKET"));
        // 价格已经跌破止损 → 方向非法(条件单会被 -2021 拒)
        assert!(!validate_trigger_price(100.0, 102.0, "SELL", "STOP_MARKET"));
        // 平空(BUY):止损必须在现价上方
        assert!(validate_trigger_price(100.0, 102.0, "BUY", "STOP_MARKET"));
        assert!(!validate_trigger_price(100.0, 98.0, "BUY", "STOP_MARKET"));
    }

    #[test]
    fn 止盈触发价方向() {
        // 平多(SELL):止盈必须在现价上方
        assert!(validate_trigger_price(100.0, 110.0, "SELL", "TAKE_PROFIT_MARKET"));
        assert!(!validate_trigger_price(100.0, 90.0, "SELL", "TAKE_PROFIT_MARKET"));
        // 平空(BUY):止盈必须在现价下方
        assert!(validate_trigger_price(100.0, 90.0, "BUY", "TAKE_PROFIT_MARKET"));
        assert!(!validate_trigger_price(100.0, 110.0, "BUY", "TAKE_PROFIT_MARKET"));
    }

    #[test]
    fn 数量向下取整不超保证金() {
        assert_eq!(round_qty(0.1239, "BTCUSDC"), 0.123);
        assert_eq!(round_qty(1.0, "BTCUSDC"), 1.0);
        assert_eq!(round_qty(0.0004, "ETHUSDC"), 0.0);
    }
}
