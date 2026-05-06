//! 交易所抽象接口定义

use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::types::{ExchangeType, Kline};

/// 交易所配置
#[derive(Debug, Clone)]
pub struct ExchangeConfig {
    pub exchange_type: ExchangeType,
    pub rest_url: String,
    pub ws_url: String,
    pub proxy: Option<String>,
    pub rate_limit_ms: u64,
}

impl Default for ExchangeConfig {
    fn default() -> Self {
        Self {
            exchange_type: ExchangeType::Binance,
            rest_url: "https://fapi.binance.com".to_string(),
            ws_url: "wss://ws-fapi.binance.com/ws-fapi/v1".to_string(),
            proxy: None,
            rate_limit_ms: 100,
        }
    }
}

/// CEX REST API Trait
#[async_trait]
pub trait ExchangeRest: Send + Sync {
    /// 获取交易所类型
    fn exchange_type(&self) -> ExchangeType;

    /// 获取历史 K 线数据
    async fn get_klines(
        &self,
        symbol: &str,
        timeframe: &str,
        limit: u32,
        start_time: Option<i64>,
        end_time: Option<i64>,
    ) -> Result<Vec<Kline>>;

    /// 批量获取 K 线（分批请求，超过单次限制时自动分页）
    async fn get_klines_batch(
        &self,
        symbol: &str,
        timeframe: &str,
        total_limit: usize,
        end_time: Option<i64>,
    ) -> Result<Vec<Kline>>;

    /// 获取单次请求的最大 K 线数量
    fn max_klines_per_request(&self) -> u32;

    /// 规范化交易对符号（各交易所格式可能不同）
    fn normalize_symbol(&self, symbol: &str) -> String;

    /// 规范化时间周期（各交易所格式可能不同）
    fn normalize_timeframe(&self, timeframe: &str) -> String;
}

/// CEX WebSocket Trait
pub trait ExchangeWs: Send + Sync {
    /// 获取交易所类型
    fn exchange_type(&self) -> ExchangeType;

    /// 添加订阅
    fn subscribe(&mut self, symbol: &str, timeframe: &str);

    /// 移除订阅
    fn unsubscribe(&mut self, symbol: &str, timeframe: &str);
}

/// 可运行的 WebSocket 客户端
#[async_trait]
pub trait ExchangeWsRunner: Send + Sync {
    /// 启动 WebSocket 连接（阻塞，内部处理重连）
    async fn run(&self) -> Result<()>;

    /// 添加订阅
    fn subscribe(&mut self, symbol: &str, timeframe: &str);

    /// 移除订阅
    fn unsubscribe(&mut self, symbol: &str, timeframe: &str);
}

/// 交易所实例（组合 REST + WebSocket）
pub trait Exchange: Send + Sync {
    /// 获取交易所类型
    fn exchange_type(&self) -> ExchangeType;

    /// 获取 REST 客户端
    fn rest(&self) -> &dyn ExchangeRest;

    /// 创建 WebSocket 客户端
    fn create_ws(&self, kline_tx: mpsc::UnboundedSender<Kline>) -> Box<dyn ExchangeWsRunner>;

    /// 获取配置
    fn config(&self) -> &ExchangeConfig;
}

/// DEX 预留接口（暂不实现）
#[async_trait]
pub trait DexExchange: Send + Sync {
    /// 获取链上 K 线数据（通过聚合 swap 事件）
    async fn get_onchain_klines(
        &self,
        pool_address: &str,
        timeframe: &str,
        limit: u32,
    ) -> Result<Vec<Kline>>;

    /// 订阅链上价格更新
    async fn subscribe_price_feed(&self, pool_address: &str) -> Result<()>;
}
