use crate::kline::{AggTrade, Kline};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 固定的杠杆档位
pub const LEVERAGE_TIERS: [u32; 4] = [10, 25, 50, 100];

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

    /// 从 aggTrades 数据生成热力图
    ///
    /// # Arguments
    /// * `symbol` - 交易对
    /// * `trades` - 聚合交易数据
    /// * `current_price` - 当前价格
    ///
    /// # Returns
    /// 热力图数据（按杠杆分层）
    pub fn generate_from_trades(
        &self,
        symbol: &str,
        trades: &[AggTrade],
        current_price: f64,
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

        // 遍历每笔交易，计算清算分布
        for trade in trades {
            let entry_price = trade.price;
            let position_value = trade.quote_qty;

            // is_buyer_maker = true: 卖单成交 (做空开仓)
            // is_buyer_maker = false: 买单成交 (做多开仓)
            let is_long = !trade.is_buyer_maker;

            // 对每个杠杆档位计算清算价
            for leverage in LEVERAGE_TIERS {
                let liq_price = Self::calc_liquidation_price(entry_price, leverage, is_long);
                let leverage_key = format!("{}x", leverage);

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

    /// 从 K线数据生成热力图（兼容旧接口）
    ///
    /// 使用 K 线成交量估算，假设 50% 买入 50% 卖出
    pub fn generate_from_klines(
        &self,
        symbol: &str,
        klines: &[Kline],
        current_price: f64,
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

        // 杠杆分布权重（基于市场经验估算）
        // 大部分交易者使用中等杠杆
        let leverage_weights: [(u32, f64); 4] = [
            (10, 0.15),   // 10x 占 15%
            (25, 0.35),   // 25x 占 35%
            (50, 0.35),   // 50x 占 35%
            (100, 0.15),  // 100x 占 15%
        ];

        // 遍历每根 K线
        for kline in klines {
            // 估算该 K 线期间的开仓量
            // 成交额的一定比例视为新开仓位，再按多空各 50% 分配
            let retention_rate = 1.0;  // 调整此值匹配市场数据
            let position_value = kline.quote_volume * retention_rate * 0.5;
            let entry_price = (kline.high + kline.low) / 2.0;

            // 对每个杠杆档位按权重计算清算价
            for (leverage, weight) in leverage_weights {
                let leverage_key = format!("{}x", leverage);
                let weighted_value = position_value * weight;

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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_trades() -> Vec<AggTrade> {
        vec![
            // 买单成交 (做多开仓)
            AggTrade {
                price: 100000.0,
                quantity: 1.0,
                quote_qty: 100000.0,
                timestamp: 0,
                is_buyer_maker: false,
            },
            // 卖单成交 (做空开仓)
            AggTrade {
                price: 100000.0,
                quantity: 0.5,
                quote_qty: 50000.0,
                timestamp: 0,
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
