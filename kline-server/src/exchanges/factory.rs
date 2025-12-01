//! 交易所工厂模式
//!
//! 根据配置创建对应的交易所实例

use std::sync::Arc;

use crate::exchanges::binance::BinanceExchange;
use crate::exchanges::{Exchange, ExchangeConfig};
use crate::types::ExchangeType;

/// 交易所工厂
pub struct ExchangeFactory;

impl ExchangeFactory {
    /// 根据交易所类型创建实例
    pub fn create(exchange_type: ExchangeType, proxy: Option<String>) -> Arc<dyn Exchange> {
        match exchange_type {
            ExchangeType::Binance => {
                let config = ExchangeConfig {
                    exchange_type: ExchangeType::Binance,
                    rest_url: "https://fapi.binance.com".to_string(),
                    ws_url: "wss://fstream.binance.com".to_string(),
                    proxy,
                    rate_limit_ms: 100,
                };
                Arc::new(BinanceExchange::new(config))
            }
            ExchangeType::Okx => {
                // OKX 实现预留
                let config = ExchangeConfig {
                    exchange_type: ExchangeType::Okx,
                    rest_url: "https://www.okx.com".to_string(),
                    ws_url: "wss://ws.okx.com:8443".to_string(),
                    proxy,
                    rate_limit_ms: 100,
                };
                // TODO: 实现 OkxExchange
                unimplemented!("OKX exchange not yet implemented")
            }
            ExchangeType::Bybit => {
                // Bybit 实现预留
                let config = ExchangeConfig {
                    exchange_type: ExchangeType::Bybit,
                    rest_url: "https://api.bybit.com".to_string(),
                    ws_url: "wss://stream.bybit.com".to_string(),
                    proxy,
                    rate_limit_ms: 100,
                };
                // TODO: 实现 BybitExchange
                unimplemented!("Bybit exchange not yet implemented")
            }
        }
    }

    /// 根据配置创建实例
    pub fn create_with_config(config: ExchangeConfig) -> Arc<dyn Exchange> {
        match config.exchange_type {
            ExchangeType::Binance => Arc::new(BinanceExchange::new(config)),
            ExchangeType::Okx => {
                unimplemented!("OKX exchange not yet implemented")
            }
            ExchangeType::Bybit => {
                unimplemented!("Bybit exchange not yet implemented")
            }
        }
    }

    /// 获取所有支持的交易所类型
    pub fn supported_exchanges() -> Vec<ExchangeType> {
        vec![
            ExchangeType::Binance,
            // ExchangeType::Okx,    // 待实现
            // ExchangeType::Bybit,  // 待实现
        ]
    }
}

/// 便捷函数：创建交易所实例
pub fn create_exchange(exchange_type: ExchangeType, proxy: Option<String>) -> Arc<dyn Exchange> {
    ExchangeFactory::create(exchange_type, proxy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_binance() {
        let exchange = ExchangeFactory::create(ExchangeType::Binance, None);
        assert_eq!(exchange.exchange_type(), ExchangeType::Binance);
    }

    #[test]
    fn test_supported_exchanges() {
        let exchanges = ExchangeFactory::supported_exchanges();
        assert!(exchanges.contains(&ExchangeType::Binance));
    }
}
