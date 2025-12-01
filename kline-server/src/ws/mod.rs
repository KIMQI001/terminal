//! K线管理器 - 整合缓存、数据库和实时推送

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock, broadcast};
use tracing::{info, debug, warn};

use crate::binance::{BinanceRest, BinanceWs};
use crate::db::KlineRepository;
use crate::types::{Kline, KlineSimple, SubscriptionKey, WsMessage};

/// 内存缓存配置
const DEFAULT_CACHE_SIZE: usize = 1000;     // 默认缓存大小
const LARGE_CACHE_SIZE: usize = 5000;       // BTC/ETH 大缓存
const DB_BATCH_SIZE: usize = 100;           // 批量写入数据库的数量

/// 根据交易对获取缓存大小
/// BTC/ETH 使用 5000 根 K 线，其他使用 1000 根
fn get_cache_size(symbol: &str) -> usize {
    match symbol.to_uppercase().as_str() {
        "BTCUSDC" | "ETHUSDC" => LARGE_CACHE_SIZE,
        _ => DEFAULT_CACHE_SIZE,
    }
}

/// K线管理器
pub struct KlineManager {
    /// 数据库仓库
    repo: Arc<KlineRepository>,
    /// REST API 客户端
    rest: BinanceRest,
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
            rest: BinanceRest::new(),
            cache: Arc::new(RwLock::new(HashMap::new())),
            broadcaster,
            pending_writes: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// 获取广播接收器
    pub fn subscribe_updates(&self) -> broadcast::Receiver<(SubscriptionKey, KlineSimple)> {
        self.broadcaster.subscribe()
    }

    /// 初始化订阅（从数据库加载 + 从 Binance 获取最新数据）
    /// BTC/ETH 会获取 5000 根 K 线，其他交易对获取 1000 根
    pub async fn init_subscription(&self, symbol: &str, timeframe: &str) -> anyhow::Result<Vec<KlineSimple>> {
        let key = SubscriptionKey::new(symbol, timeframe);
        let symbol_upper = symbol.to_uppercase();
        let cache_size = get_cache_size(&symbol_upper);

        info!(
            "Initializing subscription for {}@{} with cache size {}",
            symbol_upper, timeframe, cache_size
        );

        // 1. 先从数据库加载历史数据
        let db_klines = self.repo.get_klines(&symbol_upper, timeframe, cache_size as i64, None).await?;
        info!(
            "Loaded {} klines from DB for {}@{}",
            db_klines.len(),
            symbol_upper,
            timeframe
        );

        // 2. 计算还需要多少数据
        let need_more = db_klines.len() < cache_size;
        let mut api_klines = Vec::new();

        if need_more {
            let needed = cache_size - db_klines.len();
            // 获取数据库中最早的时间，从这个时间往前获取
            let end_time_ms = db_klines.first().map(|k| k.open_time * 1000 - 1);

            info!(
                "Need {} more klines for {}@{}, fetching from Binance...",
                needed, symbol_upper, timeframe
            );

            // 使用批量获取函数获取更多历史数据
            api_klines = self.rest.get_klines_batch(
                &symbol_upper,
                timeframe,
                needed,
                end_time_ms,
            ).await?;

            info!(
                "Fetched {} klines from Binance API for {}@{}",
                api_klines.len(),
                symbol_upper,
                timeframe
            );
        }

        // 3. 同时从 Binance 获取最新数据（补充数据库之后的新数据）
        let latest_time = db_klines.last().map(|k| k.open_time);
        let start_time_ms = latest_time.map(|t| (t + 1) * 1000);

        let recent_klines = self.rest.get_klines(
            &symbol_upper,
            timeframe,
            1000,
            start_time_ms,
            None,
        ).await.unwrap_or_default();

        if !recent_klines.is_empty() {
            info!(
                "Fetched {} recent klines from Binance for {}@{}",
                recent_klines.len(),
                symbol_upper,
                timeframe
            );
        }

        // 4. 合并所有数据
        let mut all_klines = api_klines.clone();  // 历史数据
        all_klines.extend(db_klines);              // 数据库数据
        all_klines.extend(recent_klines.clone()); // 最新数据

        // 去重并排序
        all_klines.sort_by_key(|k| k.open_time);
        all_klines.dedup_by_key(|k| k.open_time);

        // 只保留最近的 cache_size 条
        if all_klines.len() > cache_size {
            all_klines = all_klines.split_off(all_klines.len() - cache_size);
        }

        info!(
            "Final cache size for {}@{}: {} klines",
            symbol_upper, timeframe, all_klines.len()
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

    /// 获取缓存中的K线数据
    pub async fn get_cached_klines(&self, symbol: &str, timeframe: &str) -> Option<Vec<KlineSimple>> {
        let key = SubscriptionKey::new(symbol, timeframe);
        let cache = self.cache.read().await;
        cache.get(&key).map(|klines| klines.iter().map(KlineSimple::from).collect())
    }

    /// 处理来自 Binance WebSocket 的K线更新
    pub async fn handle_kline_update(&self, kline: Kline) {
        let key = SubscriptionKey::new(&kline.symbol, &kline.timeframe);
        let kline_simple = KlineSimple::from(&kline);
        let cache_size = get_cache_size(&kline.symbol);

        // 更新缓存
        {
            let mut cache = self.cache.write().await;
            if let Some(klines) = cache.get_mut(&key) {
                // 查找是否存在相同时间的K线
                if let Some(last) = klines.last_mut() {
                    if last.open_time == kline.open_time {
                        // 更新现有K线
                        *last = kline.clone();
                    } else {
                        // 添加新K线
                        klines.push(kline.clone());
                        // 保持缓存大小（按交易对配置）
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

        // 如果K线已收盘，加入待写入队列
        if kline.is_closed {
            let mut pending = self.pending_writes.write().await;
            pending.push(kline);

            // 达到批量大小时写入数据库
            if pending.len() >= DB_BATCH_SIZE {
                let to_write: Vec<_> = pending.drain(..).collect();
                drop(pending);  // 释放锁

                if let Err(e) = self.repo.batch_insert_klines(&to_write).await {
                    warn!("Failed to batch insert klines: {}", e);
                } else {
                    debug!("Batch inserted {} klines to DB", to_write.len());
                }
            }
        }
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

    /// 启动 Binance WebSocket 订阅
    pub async fn start_binance_ws(
        self: Arc<Self>,
        subscriptions: Vec<(String, String)>,
    ) -> anyhow::Result<()> {
        let (tx, mut rx) = mpsc::unbounded_channel();

        // 创建 WebSocket 客户端
        let mut ws = BinanceWs::new(tx);
        for (symbol, timeframe) in &subscriptions {
            ws.subscribe(symbol, timeframe);
        }

        // 启动消息处理任务
        let manager = Arc::clone(&self);
        tokio::spawn(async move {
            while let Some(kline) = rx.recv().await {
                manager.handle_kline_update(kline).await;
            }
        });

        // 启动 WebSocket 连接
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
