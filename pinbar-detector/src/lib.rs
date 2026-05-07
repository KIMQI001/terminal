//! Pinbar 检测服务
//!
//! 独立子项目，从 kline-server 读取 K 线数据，检测 Pinbar 信号

pub mod detector;
pub mod types;

pub use detector::{detect_swing_points, detect_engulfing_pinbar, detect_recent_pinbars};
pub use types::{Candle, PinbarSignal, PinbarUpdate, SwingPoint};