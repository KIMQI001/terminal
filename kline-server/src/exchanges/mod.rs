//! 交易所抽象层模块
//!
//! 提供统一的交易所接口，支持多个 CEX 和未来的 DEX 扩展

mod traits;
mod factory;

// Binance 实现
pub mod binance;

// 导出核心类型和 trait
pub use traits::{DexExchange, Exchange, ExchangeConfig, ExchangeRest, ExchangeWs, ExchangeWsRunner};

// 从 types 模块重导出 ExchangeType
pub use crate::types::ExchangeType;

pub use factory::{create_exchange, ExchangeFactory};
