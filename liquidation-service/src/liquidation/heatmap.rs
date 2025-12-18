use super::{calc_liquidation_price, LeverageModel};
use crate::kline::Kline;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 热力图数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeatmapData {
    pub symbol: String,
    pub prices: Vec<f64>,          // 价格数组
    pub long: Vec<f64>,            // 多头清算量 (USDT)
    pub short: Vec<f64>,           // 空头清算量 (USDT)
    #[serde(rename = "lastPrice")]
    pub last_price: f64,           // 当前价格
    #[serde(rename = "lastIndex")]
    pub last_index: usize,         // 当前价在数组中的索引
}

/// 热力图生成器
pub struct HeatmapGenerator {
    leverage_model: LeverageModel,
    bucket_size: f64,              // 价格区间大小
}

impl HeatmapGenerator {
    pub fn new(leverage_model: LeverageModel, bucket_size: f64) -> Self {
        Self {
            leverage_model,
            bucket_size,
        }
    }

    /// 从 K线数据生成热力图
    ///
    /// # Arguments
    /// * `symbol` - 交易对
    /// * `klines` - K线数据
    /// * `current_price` - 当前价格
    ///
    /// # Returns
    /// 热力图数据
    pub fn generate(&self, symbol: &str, klines: &[Kline], current_price: f64) -> HeatmapData {
        // 确定价格范围（当前价 ±30%）
        let price_min = current_price * 0.7;
        let price_max = current_price * 1.3;

        // 计算价格区间数量
        let bucket_count = ((price_max - price_min) / self.bucket_size).ceil() as usize;

        // 初始化清算量数组
        let mut long_liquidations: HashMap<usize, f64> = HashMap::new();
        let mut short_liquidations: HashMap<usize, f64> = HashMap::new();

        // 获取杠杆分布
        let leverages = self.leverage_model.get_leverages();

        // 遍历每根 K线，计算清算分布
        for kline in klines {
            // 使用 K线的成交额作为该价位的"持仓估算"
            let position_value = kline.quote_volume;

            // K线中间价作为入场价
            let entry_price = (kline.high + kline.low) / 2.0;

            // 按杠杆分布计算清算
            for leverage in &leverages {
                let ratio = self.leverage_model.get_ratio(*leverage);
                let position_for_leverage = position_value * ratio;

                // 做多清算
                let long_liq_price = calc_liquidation_price(entry_price, *leverage, true, None);
                if long_liq_price >= price_min && long_liq_price <= price_max {
                    let bucket = ((long_liq_price - price_min) / self.bucket_size) as usize;
                    if bucket < bucket_count {
                        *long_liquidations.entry(bucket).or_insert(0.0) += position_for_leverage;
                    }
                }

                // 做空清算
                let short_liq_price = calc_liquidation_price(entry_price, *leverage, false, None);
                if short_liq_price >= price_min && short_liq_price <= price_max {
                    let bucket = ((short_liq_price - price_min) / self.bucket_size) as usize;
                    if bucket < bucket_count {
                        *short_liquidations.entry(bucket).or_insert(0.0) += position_for_leverage;
                    }
                }
            }
        }

        // 构建价格数组
        let prices: Vec<f64> = (0..bucket_count)
            .map(|i| price_min + i as f64 * self.bucket_size)
            .collect();

        // 构建清算量数组
        let long: Vec<f64> = (0..bucket_count)
            .map(|i| *long_liquidations.get(&i).unwrap_or(&0.0))
            .collect();

        let short: Vec<f64> = (0..bucket_count)
            .map(|i| *short_liquidations.get(&i).unwrap_or(&0.0))
            .collect();

        // 计算当前价格的索引
        let last_index = ((current_price - price_min) / self.bucket_size) as usize;

        HeatmapData {
            symbol: symbol.to_string(),
            prices,
            long,
            short,
            last_price: current_price,
            last_index: last_index.min(bucket_count.saturating_sub(1)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_klines() -> Vec<Kline> {
        vec![
            Kline {
                open_time: 0,
                open: 100000.0,
                high: 101000.0,
                low: 99000.0,
                close: 100500.0,
                volume: 100.0,
                quote_volume: 10000000.0, // 1000万 USDT
                close_time: 0,
                trades: 1000,
            },
            Kline {
                open_time: 0,
                open: 100500.0,
                high: 102000.0,
                low: 100000.0,
                close: 101500.0,
                volume: 150.0,
                quote_volume: 15000000.0, // 1500万 USDT
                close_time: 0,
                trades: 1500,
            },
        ]
    }

    #[test]
    fn test_generate_heatmap() {
        let model = LeverageModel::new_default();
        let generator = HeatmapGenerator::new(model, 100.0);

        let klines = create_test_klines();
        let heatmap = generator.generate("BTCUSDT", &klines, 100000.0);

        // 验证基本结构
        assert_eq!(heatmap.symbol, "BTCUSDT");
        assert!(!heatmap.prices.is_empty());
        assert_eq!(heatmap.prices.len(), heatmap.long.len());
        assert_eq!(heatmap.prices.len(), heatmap.short.len());

        // 验证有清算数据
        let total_long: f64 = heatmap.long.iter().sum();
        let total_short: f64 = heatmap.short.iter().sum();
        assert!(total_long > 0.0);
        assert!(total_short > 0.0);

        println!("Heatmap generated: {} price levels", heatmap.prices.len());
        println!("Total long liquidation: {} USDT", total_long);
        println!("Total short liquidation: {} USDT", total_short);
    }
}
