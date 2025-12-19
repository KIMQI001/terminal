use crate::kline::{AggTrade, Kline, OpenInterestHist};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 固定的杠杆档位
pub const LEVERAGE_TIERS: [u32; 4] = [10, 25, 50, 100];

/// 杠杆分布权重（基于市场经验和 forceOrder 数据统计）
/// 大部分交易者使用 20-50x 杠杆
const LEVERAGE_WEIGHTS: [(u32, f64); 4] = [
    (10, 0.10),   // 10x 占 10%
    (25, 0.30),   // 25x 占 30%
    (50, 0.40),   // 50x 占 40%
    (100, 0.20),  // 100x 占 20%
];

/// 时间衰减半衰期（小时）
/// 仓位每过这么久，存活概率减半
const DECAY_HALF_LIFE_HOURS: f64 = 8.0;

/// 新开仓比例
/// 不是所有交易都是新开仓，很多是平仓或换手
/// 根据 CG 数据对比校准
const NEW_POSITION_RATIO: f64 = 0.50;

/// 计算时间衰减因子
/// 基于指数衰减模型：decay = 0.5^(hours / half_life)
fn calc_time_decay(trade_timestamp: i64, current_timestamp: i64) -> f64 {
    let hours_elapsed = (current_timestamp - trade_timestamp) as f64 / 3600000.0;
    if hours_elapsed <= 0.0 {
        return 1.0;
    }
    0.5_f64.powf(hours_elapsed / DECAY_HALF_LIFE_HOURS)
}

/// 获取杠杆权重
fn get_leverage_weight(leverage: u32) -> f64 {
    LEVERAGE_WEIGHTS
        .iter()
        .find(|(lev, _)| *lev == leverage)
        .map(|(_, weight)| *weight)
        .unwrap_or(0.25)
}

/// 热力图数据（按杠杆分层）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeatmapData {
    pub symbol: String,
    pub prices: Vec<f64>,          // 价格数组
    pub long: Vec<f64>,            // 多头清算量总计 (USDT)
    pub short: Vec<f64>,           // 空头清算量总计 (USDT)
    /// 按杠杆分层的多头清算量
    #[serde(rename = "longByLeverage")]
    pub long_by_leverage: HashMap<String, Vec<f64>>,
    /// 按杠杆分层的空头清算量
    #[serde(rename = "shortByLeverage")]
    pub short_by_leverage: HashMap<String, Vec<f64>>,
    #[serde(rename = "lastPrice")]
    pub last_price: f64,           // 当前价格
    #[serde(rename = "lastIndex")]
    pub last_index: usize,         // 当前价在数组中的索引
}

/// 热力图生成器（基于 aggTrades 和固定杠杆档位）
pub struct HeatmapGenerator {
    bucket_size: f64,              // 价格区间大小
}

impl HeatmapGenerator {
    pub fn new(bucket_size: f64) -> Self {
        Self { bucket_size }
    }

    /// 计算清算价格
    ///
    /// 做多清算：价格下跌触发，清算价 = 入场价 × (1 - 1/杠杆)
    /// 做空清算：价格上涨触发，清算价 = 入场价 × (1 + 1/杠杆)
    fn calc_liquidation_price(entry_price: f64, leverage: u32, is_long: bool) -> f64 {
        let leverage_f = leverage as f64;
        if is_long {
            // 多头清算价在入场价下方
            entry_price * (1.0 - 1.0 / leverage_f)
        } else {
            // 空头清算价在入场价上方
            entry_price * (1.0 + 1.0 / leverage_f)
        }
    }

    /// 从 aggTrades 数据生成热力图（带时间衰减和杠杆权重）
    ///
    /// # Arguments
    /// * `symbol` - 交易对
    /// * `trades` - 聚合交易数据
    /// * `current_price` - 当前价格
    /// * `current_timestamp` - 当前时间戳（毫秒），用于计算时间衰减
    ///
    /// # Returns
    /// 热力图数据（按杠杆分层）
    pub fn generate_from_trades_with_decay(
        &self,
        symbol: &str,
        trades: &[AggTrade],
        current_price: f64,
        current_timestamp: i64,
    ) -> HeatmapData {
        // 确定价格范围（当前价 ±30%）
        let price_min = current_price * 0.7;
        let price_max = current_price * 1.3;

        // 计算价格区间数量
        let bucket_count = ((price_max - price_min) / self.bucket_size).ceil() as usize;

        // 按杠杆初始化清算量数组
        let mut long_by_leverage: HashMap<String, HashMap<usize, f64>> = HashMap::new();
        let mut short_by_leverage: HashMap<String, HashMap<usize, f64>> = HashMap::new();

        for leverage in LEVERAGE_TIERS {
            long_by_leverage.insert(format!("{}x", leverage), HashMap::new());
            short_by_leverage.insert(format!("{}x", leverage), HashMap::new());
        }

        // 遍历每笔交易，计算清算分布（带时间衰减和杠杆权重）
        for trade in trades {
            let entry_price = trade.price;
            let base_value = trade.quote_qty;

            // 计算时间衰减因子：越老的仓位，存活概率越低
            let decay_factor = calc_time_decay(trade.timestamp, current_timestamp);

            // is_buyer_maker = true: 卖单成交 (做空开仓)
            // is_buyer_maker = false: 买单成交 (做多开仓)
            let is_long = !trade.is_buyer_maker;

            // 对每个杠杆档位按权重计算清算价
            for leverage in LEVERAGE_TIERS {
                let liq_price = Self::calc_liquidation_price(entry_price, leverage, is_long);
                let leverage_key = format!("{}x", leverage);

                // 应用杠杆权重、时间衰减和新开仓比例
                let weight = get_leverage_weight(leverage);
                let position_value = base_value * weight * decay_factor * NEW_POSITION_RATIO;

                if is_long {
                    // 做多清算：清算价 < 当前价格才有意义（价格下跌触发）
                    if liq_price >= price_min && liq_price < current_price {
                        let bucket = ((liq_price - price_min) / self.bucket_size) as usize;
                        if bucket < bucket_count {
                            let map = long_by_leverage.get_mut(&leverage_key).unwrap();
                            *map.entry(bucket).or_insert(0.0) += position_value;
                        }
                    }
                } else {
                    // 做空清算：清算价 > 当前价格才有意义（价格上涨触发）
                    if liq_price > current_price && liq_price <= price_max {
                        let bucket = ((liq_price - price_min) / self.bucket_size) as usize;
                        if bucket < bucket_count {
                            let map = short_by_leverage.get_mut(&leverage_key).unwrap();
                            *map.entry(bucket).or_insert(0.0) += position_value;
                        }
                    }
                }
            }
        }

        // 构建价格数组
        let prices: Vec<f64> = (0..bucket_count)
            .map(|i| price_min + i as f64 * self.bucket_size)
            .collect();

        // 转换为 Vec 格式
        let mut long_by_lev_vec: HashMap<String, Vec<f64>> = HashMap::new();
        let mut short_by_lev_vec: HashMap<String, Vec<f64>> = HashMap::new();

        for leverage in LEVERAGE_TIERS {
            let key = format!("{}x", leverage);
            let long_map = long_by_leverage.get(&key).unwrap();
            let short_map = short_by_leverage.get(&key).unwrap();

            long_by_lev_vec.insert(
                key.clone(),
                (0..bucket_count)
                    .map(|i| *long_map.get(&i).unwrap_or(&0.0))
                    .collect(),
            );
            short_by_lev_vec.insert(
                key,
                (0..bucket_count)
                    .map(|i| *short_map.get(&i).unwrap_or(&0.0))
                    .collect(),
            );
        }

        // 计算总量（所有杠杆相加）
        let long: Vec<f64> = (0..bucket_count)
            .map(|i| {
                LEVERAGE_TIERS
                    .iter()
                    .map(|lev| {
                        let key = format!("{}x", lev);
                        long_by_lev_vec.get(&key).map(|v| v[i]).unwrap_or(0.0)
                    })
                    .sum()
            })
            .collect();

        let short: Vec<f64> = (0..bucket_count)
            .map(|i| {
                LEVERAGE_TIERS
                    .iter()
                    .map(|lev| {
                        let key = format!("{}x", lev);
                        short_by_lev_vec.get(&key).map(|v| v[i]).unwrap_or(0.0)
                    })
                    .sum()
            })
            .collect();

        // 计算当前价格的索引
        let last_index = ((current_price - price_min) / self.bucket_size) as usize;

        HeatmapData {
            symbol: symbol.to_string(),
            prices,
            long,
            short,
            long_by_leverage: long_by_lev_vec,
            short_by_leverage: short_by_lev_vec,
            last_price: current_price,
            last_index: last_index.min(bucket_count.saturating_sub(1)),
        }
    }

    /// 从 aggTrades 数据生成热力图（向后兼容接口）
    ///
    /// 使用当前系统时间作为参考计算时间衰减
    pub fn generate_from_trades(
        &self,
        symbol: &str,
        trades: &[AggTrade],
        current_price: f64,
    ) -> HeatmapData {
        let current_timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        self.generate_from_trades_with_decay(symbol, trades, current_price, current_timestamp)
    }

    /// 从 K线数据生成热力图（带时间衰减）
    ///
    /// 使用 K 线成交量估算，假设 50% 买入 50% 卖出
    pub fn generate_from_klines(
        &self,
        symbol: &str,
        klines: &[Kline],
        current_price: f64,
    ) -> HeatmapData {
        let current_timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        self.generate_from_klines_with_decay(symbol, klines, current_price, current_timestamp)
    }

    /// 从 K线数据生成热力图（带时间衰减）
    ///
    /// 使用 K 线成交量估算，假设 50% 买入 50% 卖出
    pub fn generate_from_klines_with_decay(
        &self,
        symbol: &str,
        klines: &[Kline],
        current_price: f64,
        current_timestamp: i64,
    ) -> HeatmapData {
        // 确定价格范围（当前价 ±30%）
        let price_min = current_price * 0.7;
        let price_max = current_price * 1.3;

        // 计算价格区间数量
        let bucket_count = ((price_max - price_min) / self.bucket_size).ceil() as usize;

        // 按杠杆初始化清算量数组
        let mut long_by_leverage: HashMap<String, HashMap<usize, f64>> = HashMap::new();
        let mut short_by_leverage: HashMap<String, HashMap<usize, f64>> = HashMap::new();

        for leverage in LEVERAGE_TIERS {
            long_by_leverage.insert(format!("{}x", leverage), HashMap::new());
            short_by_leverage.insert(format!("{}x", leverage), HashMap::new());
        }

        // 遍历每根 K线
        for kline in klines {
            // 计算时间衰减因子
            let decay_factor = calc_time_decay(kline.close_time, current_timestamp);

            // 估算该 K 线期间的开仓量
            // 成交额的一定比例视为新开仓位，再按多空各 50% 分配
            let base_value = kline.quote_volume * 0.5;
            let entry_price = (kline.high + kline.low) / 2.0;

            // 对每个杠杆档位按权重计算清算价
            for leverage in LEVERAGE_TIERS {
                let leverage_key = format!("{}x", leverage);
                let weight = get_leverage_weight(leverage);
                let weighted_value = base_value * weight * decay_factor * NEW_POSITION_RATIO;

                // 做多清算
                let long_liq_price = Self::calc_liquidation_price(entry_price, leverage, true);
                if long_liq_price >= price_min && long_liq_price < current_price {
                    let bucket = ((long_liq_price - price_min) / self.bucket_size) as usize;
                    if bucket < bucket_count {
                        let map = long_by_leverage.get_mut(&leverage_key).unwrap();
                        *map.entry(bucket).or_insert(0.0) += weighted_value;
                    }
                }

                // 做空清算
                let short_liq_price = Self::calc_liquidation_price(entry_price, leverage, false);
                if short_liq_price > current_price && short_liq_price <= price_max {
                    let bucket = ((short_liq_price - price_min) / self.bucket_size) as usize;
                    if bucket < bucket_count {
                        let map = short_by_leverage.get_mut(&leverage_key).unwrap();
                        *map.entry(bucket).or_insert(0.0) += weighted_value;
                    }
                }
            }
        }

        // 构建价格数组
        let prices: Vec<f64> = (0..bucket_count)
            .map(|i| price_min + i as f64 * self.bucket_size)
            .collect();

        // 转换为 Vec 格式
        let mut long_by_lev_vec: HashMap<String, Vec<f64>> = HashMap::new();
        let mut short_by_lev_vec: HashMap<String, Vec<f64>> = HashMap::new();

        for leverage in LEVERAGE_TIERS {
            let key = format!("{}x", leverage);
            let long_map = long_by_leverage.get(&key).unwrap();
            let short_map = short_by_leverage.get(&key).unwrap();

            long_by_lev_vec.insert(
                key.clone(),
                (0..bucket_count)
                    .map(|i| *long_map.get(&i).unwrap_or(&0.0))
                    .collect(),
            );
            short_by_lev_vec.insert(
                key,
                (0..bucket_count)
                    .map(|i| *short_map.get(&i).unwrap_or(&0.0))
                    .collect(),
            );
        }

        // 计算总量
        let long: Vec<f64> = (0..bucket_count)
            .map(|i| {
                LEVERAGE_TIERS
                    .iter()
                    .map(|lev| {
                        let key = format!("{}x", lev);
                        long_by_lev_vec.get(&key).map(|v| v[i]).unwrap_or(0.0)
                    })
                    .sum()
            })
            .collect();

        let short: Vec<f64> = (0..bucket_count)
            .map(|i| {
                LEVERAGE_TIERS
                    .iter()
                    .map(|lev| {
                        let key = format!("{}x", lev);
                        short_by_lev_vec.get(&key).map(|v| v[i]).unwrap_or(0.0)
                    })
                    .sum()
            })
            .collect();

        let last_index = ((current_price - price_min) / self.bucket_size) as usize;

        HeatmapData {
            symbol: symbol.to_string(),
            prices,
            long,
            short,
            long_by_leverage: long_by_lev_vec,
            short_by_leverage: short_by_lev_vec,
            last_price: current_price,
            last_index: last_index.min(bucket_count.saturating_sub(1)),
        }
    }

    /// 从 aggTrades + OI 数据生成热力图
    ///
    /// 使用 OI 变化来区分开仓与平仓：
    /// - OI 增加 = 新开仓位（计入清算）
    /// - OI 减少 = 平仓（不计入清算）
    ///
    /// # Arguments
    /// * `symbol` - 交易对
    /// * `trades` - 聚合交易数据（按时间排序）
    /// * `oi_data` - Open Interest 历史数据（按时间排序）
    /// * `current_price` - 当前价格
    /// * `current_timestamp` - 当前时间戳
    pub fn generate_from_trades_with_oi(
        &self,
        symbol: &str,
        trades: &[AggTrade],
        oi_data: &[OpenInterestHist],
        current_price: f64,
        current_timestamp: i64,
    ) -> HeatmapData {
        // 确定价格范围（当前价 ±30%）
        let price_min = current_price * 0.7;
        let price_max = current_price * 1.3;

        // 计算价格区间数量
        let bucket_count = ((price_max - price_min) / self.bucket_size).ceil() as usize;

        // 按杠杆初始化清算量数组
        let mut long_by_leverage: HashMap<String, HashMap<usize, f64>> = HashMap::new();
        let mut short_by_leverage: HashMap<String, HashMap<usize, f64>> = HashMap::new();

        for leverage in LEVERAGE_TIERS {
            long_by_leverage.insert(format!("{}x", leverage), HashMap::new());
            short_by_leverage.insert(format!("{}x", leverage), HashMap::new());
        }

        // 构建 OI 变化查找表：timestamp -> OI 变化率
        // OI 变化率 > 1 表示 OI 增加（新开仓），< 1 表示 OI 减少（平仓）
        let oi_changes: Vec<(i64, f64)> = oi_data
            .windows(2)
            .map(|w| {
                let change_rate = if w[0].sum_open_interest_value > 0.0 {
                    w[1].sum_open_interest_value / w[0].sum_open_interest_value
                } else {
                    1.0
                };
                (w[1].timestamp, change_rate)
            })
            .collect();

        // 遍历每笔交易
        for trade in trades {
            let entry_price = trade.price;
            let base_value = trade.quote_qty;

            // 计算时间衰减因子
            let decay_factor = calc_time_decay(trade.timestamp, current_timestamp);

            // 查找该交易时间对应的 OI 变化率
            // 找最接近的 OI 时间点
            let oi_factor = oi_changes
                .iter()
                .filter(|(ts, _)| *ts <= trade.timestamp)
                .last()
                .map(|(_, rate)| {
                    // OI 增加时，rate > 1，转换为开仓因子
                    // 例如：OI 增加 5% -> rate = 1.05 -> factor = 0.05 / 0.05 = 1.0
                    // OI 减少时，rate < 1，说明在平仓，新开仓较少
                    // 例如：OI 减少 5% -> rate = 0.95 -> factor = 0
                    if *rate > 1.0 {
                        // OI 增加，全部视为新开仓
                        1.0
                    } else {
                        // OI 减少或不变，只有部分是新开仓
                        // 用 rate 作为开仓因子
                        (*rate).max(0.0)
                    }
                })
                .unwrap_or(1.0); // 没有 OI 数据时默认全部计入

            // is_buyer_maker = true: 卖单成交 (做空开仓)
            // is_buyer_maker = false: 买单成交 (做多开仓)
            let is_long = !trade.is_buyer_maker;

            // 对每个杠杆档位按权重计算清算价
            for leverage in LEVERAGE_TIERS {
                let liq_price = Self::calc_liquidation_price(entry_price, leverage, is_long);
                let leverage_key = format!("{}x", leverage);

                // 应用杠杆权重、时间衰减和 OI 因子
                let weight = get_leverage_weight(leverage);
                let position_value = base_value * weight * decay_factor * oi_factor;

                if is_long {
                    if liq_price >= price_min && liq_price < current_price {
                        let bucket = ((liq_price - price_min) / self.bucket_size) as usize;
                        if bucket < bucket_count {
                            let map = long_by_leverage.get_mut(&leverage_key).unwrap();
                            *map.entry(bucket).or_insert(0.0) += position_value;
                        }
                    }
                } else {
                    if liq_price > current_price && liq_price <= price_max {
                        let bucket = ((liq_price - price_min) / self.bucket_size) as usize;
                        if bucket < bucket_count {
                            let map = short_by_leverage.get_mut(&leverage_key).unwrap();
                            *map.entry(bucket).or_insert(0.0) += position_value;
                        }
                    }
                }
            }
        }

        // 构建价格数组
        let prices: Vec<f64> = (0..bucket_count)
            .map(|i| price_min + i as f64 * self.bucket_size)
            .collect();

        // 转换为 Vec 格式
        let mut long_by_lev_vec: HashMap<String, Vec<f64>> = HashMap::new();
        let mut short_by_lev_vec: HashMap<String, Vec<f64>> = HashMap::new();

        for leverage in LEVERAGE_TIERS {
            let key = format!("{}x", leverage);
            let long_map = long_by_leverage.get(&key).unwrap();
            let short_map = short_by_leverage.get(&key).unwrap();

            long_by_lev_vec.insert(
                key.clone(),
                (0..bucket_count)
                    .map(|i| *long_map.get(&i).unwrap_or(&0.0))
                    .collect(),
            );
            short_by_lev_vec.insert(
                key,
                (0..bucket_count)
                    .map(|i| *short_map.get(&i).unwrap_or(&0.0))
                    .collect(),
            );
        }

        // 计算总量
        let long: Vec<f64> = (0..bucket_count)
            .map(|i| {
                LEVERAGE_TIERS
                    .iter()
                    .map(|lev| {
                        let key = format!("{}x", lev);
                        long_by_lev_vec.get(&key).map(|v| v[i]).unwrap_or(0.0)
                    })
                    .sum()
            })
            .collect();

        let short: Vec<f64> = (0..bucket_count)
            .map(|i| {
                LEVERAGE_TIERS
                    .iter()
                    .map(|lev| {
                        let key = format!("{}x", lev);
                        short_by_lev_vec.get(&key).map(|v| v[i]).unwrap_or(0.0)
                    })
                    .sum()
            })
            .collect();

        let last_index = ((current_price - price_min) / self.bucket_size) as usize;

        HeatmapData {
            symbol: symbol.to_string(),
            prices,
            long,
            short,
            long_by_leverage: long_by_lev_vec,
            short_by_leverage: short_by_lev_vec,
            last_price: current_price,
            last_index: last_index.min(bucket_count.saturating_sub(1)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_trades() -> Vec<AggTrade> {
        // 使用当前时间附近的时间戳，避免时间衰减导致数据为 0
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        vec![
            // 买单成交 (做多开仓)
            AggTrade {
                price: 100000.0,
                quantity: 1.0,
                quote_qty: 100000.0,
                timestamp: now - 3600000, // 1 小时前
                is_buyer_maker: false,
            },
            // 卖单成交 (做空开仓)
            AggTrade {
                price: 100000.0,
                quantity: 0.5,
                quote_qty: 50000.0,
                timestamp: now - 3600000, // 1 小时前
                is_buyer_maker: true,
            },
        ]
    }

    #[test]
    fn test_calc_liquidation_price() {
        let entry = 100000.0;

        // 10x 多头：清算价 = 100000 * (1 - 0.1) = 90000
        assert!((HeatmapGenerator::calc_liquidation_price(entry, 10, true) - 90000.0).abs() < 0.01);

        // 10x 空头：清算价 = 100000 * (1 + 0.1) = 110000
        assert!((HeatmapGenerator::calc_liquidation_price(entry, 10, false) - 110000.0).abs() < 0.01);

        // 100x 多头：清算价 = 100000 * (1 - 0.01) = 99000
        assert!((HeatmapGenerator::calc_liquidation_price(entry, 100, true) - 99000.0).abs() < 0.01);

        // 100x 空头：清算价 = 100000 * (1 + 0.01) = 101000
        assert!((HeatmapGenerator::calc_liquidation_price(entry, 100, false) - 101000.0).abs() < 0.01);
    }

    #[test]
    fn test_generate_from_trades() {
        let generator = HeatmapGenerator::new(100.0);
        let trades = create_test_trades();
        let heatmap = generator.generate_from_trades("BTCUSDT", &trades, 100000.0);

        // 验证基本结构
        assert_eq!(heatmap.symbol, "BTCUSDT");
        assert!(!heatmap.prices.is_empty());
        assert_eq!(heatmap.prices.len(), heatmap.long.len());
        assert_eq!(heatmap.prices.len(), heatmap.short.len());

        // 验证有分层数据
        assert!(heatmap.long_by_leverage.contains_key("10x"));
        assert!(heatmap.long_by_leverage.contains_key("100x"));

        // 验证有清算数据
        let total_long: f64 = heatmap.long.iter().sum();
        let total_short: f64 = heatmap.short.iter().sum();

        println!("Total long liquidation: {} USDT", total_long);
        println!("Total short liquidation: {} USDT", total_short);

        // 多头应该在当前价下方有清算
        assert!(total_long > 0.0);
        // 空头应该在当前价上方有清算
        assert!(total_short > 0.0);
    }
}
