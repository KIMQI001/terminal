//! K线管理器 - 整合缓存、数据库和实时推送

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};
use tracing::{debug, info, warn};

use crate::db::KlineRepository;
use crate::exchanges::{Exchange, ExchangeRest, ExchangeWs};
use crate::types::{aggregate_to_4d, ExchangeType, Kline, KlineSimple, SubscriptionKey, Timeframe, WsMessage};

/// 内存缓存配置
const DEFAULT_CACHE_SIZE: usize = 1000; // 默认缓存大小
const LARGE_CACHE_SIZE: usize = 5000; // BTC/ETH 大缓存
const DB_BATCH_SIZE: usize = 100; // 批量写入数据库的数量

/// 获取时间周期的秒数
fn get_timeframe_seconds(timeframe: &str) -> i64 {
    match timeframe {
        "1m" => 60,
        "5m" => 300,
        "15m" => 900,
        "1h" => 3600,
        "4h" => 14400,
        "1d" => 86400,
        "4d" => 345600,
        "1w" => 604800,
        _ => 3600, // 默认 1h
    }
}

/// 检测并修复缺失的 K 线
async fn fix_missing_klines(
    klines: &mut Vec<Kline>,
    symbol: &str,
    timeframe: &str,
    exchange: &Arc<dyn Exchange>,
) -> anyhow::Result<()> {
    if klines.len() < 2 {
        return Ok(());
    }

    let tf_seconds = get_timeframe_seconds(timeframe);
    let mut missing_ranges: Vec<(i64, i64)> = Vec::new();
    let mut i = 1;

    // 检测缺失区间
    while i < klines.len() {
        let prev_time = klines[i - 1].open_time;
        let curr_time = klines[i].open_time;
        let expected_diff = tf_seconds;

        // 跳过无效数据（时间戳为0或负数）
        if prev_time <= 0 || curr_time <= 0 {
            i += 1;
            continue;
        }

        let time_diff = curr_time - prev_time;

        // 如果时间差大于周期，说明有缺失（允许1秒误差）
        if time_diff > expected_diff + 1 {
            let missing_count = (time_diff / expected_diff) as usize - 1;
            if missing_count > 0 && missing_count <= 100 {
                // 缺失太多可能是数据问题，跳过
                let start_time = prev_time + expected_diff;
                let end_time = curr_time - expected_diff;
                missing_ranges.push((start_time, end_time));
                info!(
                    "[{}] Detected {} missing klines between {} and {} (diff={}) for {}@{}",
                    exchange.exchange_type().as_str(),
                    missing_count,
                    start_time,
                    end_time,
                    time_diff,
                    symbol,
                    timeframe
                );
            }
        }
        i += 1;
    }

    if missing_ranges.is_empty() {
        return Ok(());
    }

    // 获取 REST API 来补数据
    let rest = exchange.rest();

    for (start_time, end_time) in missing_ranges {
        let start_ms = start_time * 1000;
        let end_ms = end_time * 1000;

        // 计算需要获取多少根
        let count = ((end_time - start_time) / tf_seconds) as u32 + 1;

        info!(
            "[{}] Fetching {} missing klines for {}@{} from {} to {}",
            exchange.exchange_type().as_str(),
            count,
            symbol,
            timeframe,
            start_time,
            end_time
        );

        match rest.get_klines(symbol, timeframe, count, Some(start_ms), Some(end_ms)).await {
            Ok(filled_klines) if !filled_klines.is_empty() => {
                let before_count = klines.len();
                klines.extend(filled_klines);
                klines.sort_by_key(|k| k.open_time);
                klines.dedup_by_key(|k| k.open_time);
                info!(
                    "[{}] Fixed {} missing klines, total now: {}",
                    exchange.exchange_type().as_str(),
                    klines.len() - before_count,
                    klines.len()
                );
            }
            Ok(_) => {
                warn!(
                    "[{}] No klines returned for missing range {} to {}",
                    exchange.exchange_type().as_str(),
                    start_time,
                    end_time
                );
            }
            Err(e) => {
                warn!(
                    "[{}] Failed to fetch missing klines: {}",
                    exchange.exchange_type().as_str(),
                    e
                );
            }
        }
    }

    Ok(())
}

/// 根据交易对获取缓存大小
/// BTC/ETH 使用 5000 根 K 线，其他使用 1000 根
fn get_cache_size(symbol: &str) -> usize {
    let s = symbol.to_uppercase();
    if s.starts_with("BTC") || s.starts_with("ETH") {
        LARGE_CACHE_SIZE
    } else {
        DEFAULT_CACHE_SIZE
    }
}

/// K线管理器
pub struct KlineManager {
    /// 数据库仓库
    repo: Arc<KlineRepository>,
    /// 交易所实例（支持多个交易所）
    exchanges: Arc<RwLock<HashMap<ExchangeType, Arc<dyn Exchange>>>>,
    /// 默认交易所
    default_exchange: ExchangeType,
    /// 内存缓存：(symbol, timeframe) -> Vec<Kline>
    cache: Arc<RwLock<HashMap<SubscriptionKey, Vec<Kline>>>>,
    /// 广播通道：向所有客户端推送更新
    broadcaster: broadcast::Sender<(SubscriptionKey, KlineSimple)>,
    /// 待写入数据库的K线队列
    pending_writes: Arc<RwLock<Vec<Kline>>>,
}

impl KlineManager {
    pub fn new(repo: KlineRepository) -> Self {
        let (broadcaster, _) = broadcast::channel(1000);

        Self {
            repo: Arc::new(repo),
            exchanges: Arc::new(RwLock::new(HashMap::new())),
            default_exchange: ExchangeType::Binance,
            cache: Arc::new(RwLock::new(HashMap::new())),
            broadcaster,
            pending_writes: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// 注册交易所实例
    pub async fn register_exchange(&self, exchange: Arc<dyn Exchange>) {
        let exchange_type = exchange.exchange_type();
        let mut exchanges = self.exchanges.write().await;
        exchanges.insert(exchange_type, exchange);
        info!("Registered exchange: {}", exchange_type);
    }

    /// 设置默认交易所
    pub fn set_default_exchange(&mut self, exchange_type: ExchangeType) {
        self.default_exchange = exchange_type;
    }

    /// 获取交易所实例
    async fn get_exchange(&self, exchange_type: Option<ExchangeType>) -> Option<Arc<dyn Exchange>> {
        let et = exchange_type.unwrap_or(self.default_exchange);
        let exchanges = self.exchanges.read().await;
        exchanges.get(&et).cloned()
    }

    /// 获取广播接收器
    pub fn subscribe_updates(&self) -> broadcast::Receiver<(SubscriptionKey, KlineSimple)> {
        self.broadcaster.subscribe()
    }

    /// 初始化订阅（从数据库加载 + 从交易所获取最新数据）
    /// BTC/ETH 会获取 5000 根 K 线，其他交易对获取 1000 根
    pub async fn init_subscription(
        &self,
        symbol: &str,
        timeframe: &str,
    ) -> anyhow::Result<Vec<KlineSimple>> {
        self.init_subscription_with_exchange(symbol, timeframe, None)
            .await
    }

    /// 初始化订阅（指定交易所）
    pub async fn init_subscription_with_exchange(
        &self,
        symbol: &str,
        timeframe: &str,
        exchange_type: Option<ExchangeType>,
    ) -> anyhow::Result<Vec<KlineSimple>> {
        let key = SubscriptionKey::new(symbol, timeframe);
        let symbol_upper = symbol.to_uppercase();
        let cache_size = get_cache_size(&symbol_upper);

        // 检查是否需要聚合（如 4D）
        let tf = Timeframe::from_str(timeframe);
        let needs_aggregation = tf.map(|t| t.needs_aggregation()).unwrap_or(false);

        if needs_aggregation {
            return self
                .init_aggregated_subscription(symbol, timeframe, exchange_type, cache_size)
                .await;
        }

        // 获取交易所实例
        let exchange = self
            .get_exchange(exchange_type)
            .await
            .ok_or_else(|| anyhow::anyhow!("Exchange not registered"))?;

        let exchange_name = exchange.exchange_type().as_str();
        let rest = exchange.rest();

        info!(
            "[{}] Initializing subscription for {}@{} with cache size {}",
            exchange_name, symbol_upper, timeframe, cache_size
        );

        // 1. 先从数据库加载历史数据
        let db_klines = self
            .repo
            .get_klines(&symbol_upper, timeframe, cache_size as i64, None)
            .await?;
        info!(
            "[{}] Loaded {} klines from DB for {}@{}",
            exchange_name,
            db_klines.len(),
            symbol_upper,
            timeframe
        );

        // 2. 计算还需要多少数据
        let need_more = db_klines.len() < cache_size;
        let mut api_klines = Vec::new();

        if need_more {
            let needed = cache_size - db_klines.len();
            let end_time_ms = db_klines.first().map(|k| k.open_time * 1000 - 1);

            info!(
                "[{}] Need {} more klines for {}@{}, fetching from API...",
                exchange_name, needed, symbol_upper, timeframe
            );

            api_klines = rest
                .get_klines_batch(&symbol_upper, timeframe, needed, end_time_ms)
                .await?;

            info!(
                "[{}] Fetched {} klines from API for {}@{}",
                exchange_name,
                api_klines.len(),
                symbol_upper,
                timeframe
            );
        }

        // 3. 同时获取最新数据（补充数据库之后的新数据）
        let latest_time = db_klines.last().map(|k| k.open_time);
        let start_time_ms = latest_time.map(|t| (t + 1) * 1000);

        let recent_klines = rest
            .get_klines(&symbol_upper, timeframe, 1000, start_time_ms, None)
            .await
            .unwrap_or_default();

        if !recent_klines.is_empty() {
            info!(
                "[{}] Fetched {} recent klines from API for {}@{}",
                exchange_name,
                recent_klines.len(),
                symbol_upper,
                timeframe
            );
        }

        // 4. 合并所有数据
        let mut all_klines = api_klines.clone();
        all_klines.extend(db_klines);
        all_klines.extend(recent_klines.clone());

        // 去重并排序
        all_klines.sort_by_key(|k| k.open_time);
        all_klines.dedup_by_key(|k| k.open_time);

        // 4.5 检测并修复中间缺失的 K 线
        fix_missing_klines(&mut all_klines, &symbol_upper, timeframe, &exchange).await?;

        // 只保留最近的 cache_size 条
        if all_klines.len() > cache_size {
            all_klines = all_klines.split_off(all_klines.len() - cache_size);
        }

        info!(
            "[{}] Final cache size for {}@{}: {} klines",
            exchange_name,
            symbol_upper,
            timeframe,
            all_klines.len()
        );

        // 更新缓存
        {
            let mut cache = self.cache.write().await;
            cache.insert(key, all_klines.clone());
        }

        // 5. 将新数据写入数据库
        let mut to_write = api_klines;
        to_write.extend(recent_klines);
        if !to_write.is_empty() {
            self.repo.batch_insert_klines(&to_write).await?;
        }

        // 6. 返回简化格式给客户端
        Ok(all_klines.iter().map(KlineSimple::from).collect())
    }

    /// 初始化需要聚合的订阅（如 4D）
    async fn init_aggregated_subscription(
        &self,
        symbol: &str,
        timeframe: &str,
        exchange_type: Option<ExchangeType>,
        cache_size: usize,
    ) -> anyhow::Result<Vec<KlineSimple>> {
        let key = SubscriptionKey::new(symbol, timeframe);
        let symbol_upper = symbol.to_uppercase();

        // 获取交易所实例
        let exchange = self
            .get_exchange(exchange_type)
            .await
            .ok_or_else(|| anyhow::anyhow!("Exchange not registered"))?;

        let exchange_name = exchange.exchange_type().as_str();
        let rest = exchange.rest();

        info!(
            "[{}] Initializing aggregated subscription for {}@{} (needs 1D data)",
            exchange_name, symbol_upper, timeframe
        );

        // 4D 需要 4 倍的 1D 数据来聚合
        let base_timeframe = "1d";
        let base_count = cache_size * 4;

        // 1. 从数据库加载 1D 历史数据
        let db_klines = self
            .repo
            .get_klines(&symbol_upper, base_timeframe, base_count as i64, None)
            .await?;

        info!(
            "[{}] Loaded {} 1D klines from DB for aggregation",
            exchange_name,
            db_klines.len()
        );

        // 2. 从 API 获取更多数据（如果需要）
        let mut api_klines = Vec::new();
        if db_klines.len() < base_count {
            let needed = base_count - db_klines.len();
            let end_time_ms = db_klines.first().map(|k| k.open_time * 1000 - 1);

            info!(
                "[{}] Need {} more 1D klines, fetching from API...",
                exchange_name, needed
            );

            api_klines = rest
                .get_klines_batch(&symbol_upper, base_timeframe, needed, end_time_ms)
                .await?;

            info!(
                "[{}] Fetched {} 1D klines from API",
                exchange_name,
                api_klines.len()
            );
        }

        // 3. 获取最新 1D 数据
        let latest_time = db_klines.last().map(|k| k.open_time);
        let start_time_ms = latest_time.map(|t| (t + 1) * 1000);

        let recent_klines = rest
            .get_klines(&symbol_upper, base_timeframe, 1000, start_time_ms, None)
            .await
            .unwrap_or_default();

        if !recent_klines.is_empty() {
            info!(
                "[{}] Fetched {} recent 1D klines from API",
                exchange_name,
                recent_klines.len()
            );
        }

        // 4. 合并所有 1D 数据
        let mut all_daily = api_klines.clone();
        all_daily.extend(db_klines);
        all_daily.extend(recent_klines.clone());

        // 去重并排序
        all_daily.sort_by_key(|k| k.open_time);
        all_daily.dedup_by_key(|k| k.open_time);

        info!(
            "[{}] Total {} 1D klines for aggregation",
            exchange_name,
            all_daily.len()
        );

        // 5. 聚合为 4D
        let aggregated = aggregate_to_4d(&all_daily);

        // 只保留最近的 cache_size 条
        let mut final_klines = aggregated;
        if final_klines.len() > cache_size {
            final_klines = final_klines.split_off(final_klines.len() - cache_size);
        }

        info!(
            "[{}] Final cache size for {}@{}: {} klines (aggregated from 1D)",
            exchange_name,
            symbol_upper,
            timeframe,
            final_klines.len()
        );

        // 更新缓存
        {
            let mut cache = self.cache.write().await;
            cache.insert(key, final_klines.clone());
        }

        // 6. 将 1D 数据写入数据库（4D 不写入，因为是计算得出的）
        let mut to_write = api_klines;
        to_write.extend(recent_klines);
        if !to_write.is_empty() {
            self.repo.batch_insert_klines(&to_write).await?;
        }

        // 7. 返回简化格式给客户端
        Ok(final_klines.iter().map(KlineSimple::from).collect())
    }

    /// 获取缓存中的K线数据
    pub async fn get_cached_klines(
        &self,
        symbol: &str,
        timeframe: &str,
    ) -> Option<Vec<KlineSimple>> {
        let key = SubscriptionKey::new(symbol, timeframe);
        let cache = self.cache.read().await;
        cache
            .get(&key)
            .map(|klines| klines.iter().map(KlineSimple::from).collect())
    }

    /// 处理来自交易所 WebSocket 的K线更新
    pub async fn handle_kline_update(&self, kline: Kline) {
        let key = SubscriptionKey::new(&kline.symbol, &kline.timeframe);
        let kline_simple = KlineSimple::from(&kline);
        let cache_size = get_cache_size(&kline.symbol);

        // 更新缓存
        {
            let mut cache = self.cache.write().await;
            if let Some(klines) = cache.get_mut(&key) {
                if let Some(last) = klines.last_mut() {
                    if last.open_time == kline.open_time {
                        *last = kline.clone();
                    } else {
                        klines.push(kline.clone());
                        if klines.len() > cache_size {
                            klines.remove(0);
                        }
                    }
                } else {
                    klines.push(kline.clone());
                }
            }
        }

        // 广播更新给客户端
        let _ = self.broadcaster.send((key.clone(), kline_simple));

        // 如果是 1D K线更新，同时更新 4D 缓存
        if kline.timeframe == "1d" {
            self.update_aggregated_cache(&kline).await;
        }

        // 如果K线已收盘，加入待写入队列
        if kline.is_closed {
            let mut pending = self.pending_writes.write().await;
            pending.push(kline);

            if pending.len() >= DB_BATCH_SIZE {
                let to_write: Vec<_> = pending.drain(..).collect();
                drop(pending);

                if let Err(e) = self.repo.batch_insert_klines(&to_write).await {
                    warn!("Failed to batch insert klines: {}", e);
                } else {
                    debug!("Batch inserted {} klines to DB", to_write.len());
                }
            }
        }
    }

    /// 当 1D K线更新时，同步更新聚合的 4D 缓存
    async fn update_aggregated_cache(&self, daily_kline: &Kline) {
        use crate::types::get_4d_period_start;

        let key_4d = SubscriptionKey::new(&daily_kline.symbol, "4d");

        // 检查是否有 4D 订阅
        let has_4d_subscription = {
            let cache = self.cache.read().await;
            cache.contains_key(&key_4d)
        };

        if !has_4d_subscription {
            return;
        }

        // 获取 1D 缓存中属于当前 4D 周期的所有 K 线
        let key_1d = SubscriptionKey::new(&daily_kline.symbol, "1d");
        let period_start = get_4d_period_start(daily_kline.open_time);

        let period_klines: Vec<Kline> = {
            let cache = self.cache.read().await;
            if let Some(daily_cache) = cache.get(&key_1d) {
                daily_cache
                    .iter()
                    .filter(|k| get_4d_period_start(k.open_time) == period_start)
                    .cloned()
                    .collect()
            } else {
                return;
            }
        };

        if period_klines.is_empty() {
            return;
        }

        // 计算聚合后的 4D K 线
        let first = &period_klines[0];
        let last = period_klines.last().unwrap();

        let aggregated_kline = Kline {
            symbol: daily_kline.symbol.clone(),
            timeframe: "4d".to_string(),
            open_time: period_start,
            open: first.open,
            high: period_klines.iter().map(|k| k.high).fold(f64::NEG_INFINITY, f64::max),
            low: period_klines.iter().map(|k| k.low).fold(f64::INFINITY, f64::min),
            close: last.close,
            volume: period_klines.iter().map(|k| k.volume).sum(),
            close_time: period_start + 4 * 24 * 60 * 60 - 1,
            quote_volume: period_klines.iter().map(|k| k.quote_volume).sum(),
            trades: period_klines.iter().map(|k| k.trades).sum(),
            is_closed: period_klines.len() == 4 && last.is_closed,
        };

        let cache_size = get_cache_size(&daily_kline.symbol);

        // 更新 4D 缓存
        {
            let mut cache = self.cache.write().await;
            if let Some(klines_4d) = cache.get_mut(&key_4d) {
                // 查找是否已有这个周期的 K 线
                if let Some(existing) = klines_4d.iter_mut().find(|k| k.open_time == period_start) {
                    *existing = aggregated_kline.clone();
                } else {
                    // 新周期，添加到末尾
                    klines_4d.push(aggregated_kline.clone());
                    if klines_4d.len() > cache_size {
                        klines_4d.remove(0);
                    }
                }
            }
        }

        // 广播 4D 更新
        let kline_simple = KlineSimple::from(&aggregated_kline);
        let _ = self.broadcaster.send((key_4d, kline_simple));
    }

    /// 强制刷新待写入队列到数据库
    pub async fn flush_pending_writes(&self) -> anyhow::Result<()> {
        let mut pending = self.pending_writes.write().await;
        if pending.is_empty() {
            return Ok(());
        }

        let to_write: Vec<_> = pending.drain(..).collect();
        drop(pending);

        self.repo.batch_insert_klines(&to_write).await?;
        info!("Flushed {} klines to DB", to_write.len());

        Ok(())
    }

    /// 启动交易所 WebSocket 订阅（通用版本）
    pub async fn start_exchange_ws(
        self: Arc<Self>,
        exchange_type: ExchangeType,
        subscriptions: Vec<(String, String)>,
    ) -> anyhow::Result<()> {
        // 获取交易所实例
        let exchange = self
            .get_exchange(Some(exchange_type))
            .await
            .ok_or_else(|| anyhow::anyhow!("Exchange {} not registered", exchange_type))?;

        let (tx, mut rx) = mpsc::unbounded_channel();

        // 创建 WebSocket 客户端
        let mut ws_runner = exchange.create_ws(tx);

        // 通过 downcast 获取可变引用来添加订阅
        // 注意：由于 trait object 的限制，这里需要使用一个变通方法
        // 我们在创建 ws 时就传入订阅信息

        // 启动消息处理任务
        let manager = Arc::clone(&self);
        tokio::spawn(async move {
            while let Some(kline) = rx.recv().await {
                manager.handle_kline_update(kline).await;
            }
        });

        // 启动 WebSocket 连接
        ws_runner.run().await
    }

    /// 启动 Binance WebSocket 订阅（向后兼容）
    pub async fn start_binance_ws(
        self: Arc<Self>,
        subscriptions: Vec<(String, String)>,
    ) -> anyhow::Result<()> {
        // 使用新的 exchanges::binance::BinanceWs，它支持代理配置
        use crate::exchanges::binance::BinanceExchange;

        let exchange = BinanceExchange::default_futures();
        let (tx, mut rx) = mpsc::unbounded_channel();

        let mut ws = exchange.create_ws(tx);
        for (symbol, timeframe) in &subscriptions {
            ws.subscribe(symbol, timeframe);
        }

        let manager = Arc::clone(&self);
        tokio::spawn(async move {
            while let Some(kline) = rx.recv().await {
                manager.handle_kline_update(kline).await;
            }
        });

        ws.run().await
    }
}

/// 客户端会话管理
pub struct ClientSession {
    pub id: String,
    pub subscriptions: Vec<SubscriptionKey>,
    pub tx: mpsc::UnboundedSender<WsMessage>,
}

impl ClientSession {
    pub fn new(id: String, tx: mpsc::UnboundedSender<WsMessage>) -> Self {
        Self {
            id,
            subscriptions: Vec::new(),
            tx,
        }
    }

    pub fn subscribe(&mut self, symbol: &str, timeframe: &str) {
        let key = SubscriptionKey::new(symbol, timeframe);
        if !self.subscriptions.contains(&key) {
            self.subscriptions.push(key);
        }
    }

    pub fn unsubscribe(&mut self, symbol: &str, timeframe: &str) {
        let key = SubscriptionKey::new(symbol, timeframe);
        self.subscriptions.retain(|k| k != &key);
    }

    pub fn is_subscribed(&self, key: &SubscriptionKey) -> bool {
        self.subscriptions.contains(key)
    }
}
