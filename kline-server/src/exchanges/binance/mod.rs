//! Binance 合约交易所实现

mod rest;
mod websocket;

use std::sync::Arc;
use tokio::sync::mpsc;

use crate::exchanges::{Exchange, ExchangeConfig, ExchangeRest, ExchangeWsRunner};
use crate::types::ExchangeType;
use crate::types::Kline;

pub use rest::BinanceRest;
pub use websocket::BinanceWs;

/// Binance 交易所实例
pub struct BinanceExchange {
    config: ExchangeConfig,
    rest: Arc<BinanceRest>,
}

impl BinanceExchange {
    pub fn new(config: ExchangeConfig) -> Self {
        let rest = Arc::new(BinanceRest::new(config.clone()));
        Self { config, rest }
    }

    /// 使用默认配置创建实例
    pub fn default_futures() -> Self {
        Self::new(ExchangeConfig {
            exchange_type: ExchangeType::Binance,
            rest_url: "https://fapi.binance.com".to_string(),
            ws_url: "wss://ws-fapi.binance.com/ws-fapi/v1".to_string(),
            proxy: std::env::var("SOCKS5_PROXY").ok(),
            rate_limit_ms: 100,
        })
    }
}

impl Exchange for BinanceExchange {
    fn exchange_type(&self) -> ExchangeType {
        ExchangeType::Binance
    }

    fn rest(&self) -> &dyn ExchangeRest {
        self.rest.as_ref()
    }

    fn create_ws(&self, kline_tx: mpsc::UnboundedSender<Kline>) -> Box<dyn ExchangeWsRunner> {
        Box::new(BinanceWs::new(kline_tx, self.config.clone()))
    }

    fn config(&self) -> &ExchangeConfig {
        &self.config
    }
}
