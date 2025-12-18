use std::collections::HashMap;

/// 杠杆分布模型
#[derive(Debug, Clone)]
pub struct LeverageModel {
    /// 杠杆倍数 -> 占比
    distribution: HashMap<u32, f64>,
}

impl LeverageModel {
    /// 创建预设杠杆分布模型
    pub fn new_default() -> Self {
        let mut distribution = HashMap::new();
        // 基于市场经验估算的杠杆分布
        distribution.insert(10, 0.15);   // 10x 占 15%
        distribution.insert(20, 0.35);   // 20x 占 35%
        distribution.insert(50, 0.30);   // 50x 占 30%
        distribution.insert(100, 0.15);  // 100x 占 15%
        distribution.insert(125, 0.05);  // 125x 占 5%

        Self { distribution }
    }

    /// 从配置创建
    pub fn from_config(distribution: HashMap<u32, f64>) -> Self {
        Self { distribution }
    }

    /// 获取杠杆分布
    pub fn get_distribution(&self) -> &HashMap<u32, f64> {
        &self.distribution
    }

    /// 获取所有杠杆倍数（按从小到大排序）
    pub fn get_leverages(&self) -> Vec<u32> {
        let mut leverages: Vec<u32> = self.distribution.keys().cloned().collect();
        leverages.sort();
        leverages
    }

    /// 获取指定杠杆的占比
    pub fn get_ratio(&self, leverage: u32) -> f64 {
        *self.distribution.get(&leverage).unwrap_or(&0.0)
    }

    /// 更新杠杆分布（用于动态学习）
    pub fn update_distribution(&mut self, new_distribution: HashMap<u32, f64>) {
        self.distribution = new_distribution;
    }

    /// 从爆仓数据学习杠杆分布
    pub fn learn_from_liquidations(&mut self, liquidations: &[(u32, u64)]) {
        if liquidations.is_empty() {
            return;
        }

        // 统计各杠杆的清算次数
        let mut counts: HashMap<u32, u64> = HashMap::new();
        let mut total = 0u64;

        for (leverage, count) in liquidations {
            // 将杠杆归类到最近的标准杠杆倍数
            let standard_leverage = Self::round_to_standard_leverage(*leverage);
            *counts.entry(standard_leverage).or_insert(0) += count;
            total += count;
        }

        if total == 0 {
            return;
        }

        // 计算新的分布比例
        let mut new_distribution = HashMap::new();
        for (leverage, count) in counts {
            new_distribution.insert(leverage, count as f64 / total as f64);
        }

        self.distribution = new_distribution;
    }

    /// 将任意杠杆归类到标准杠杆倍数
    fn round_to_standard_leverage(leverage: u32) -> u32 {
        match leverage {
            1..=15 => 10,
            16..=35 => 20,
            36..=75 => 50,
            76..=112 => 100,
            _ => 125,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_model() {
        let model = LeverageModel::new_default();
        let leverages = model.get_leverages();

        assert_eq!(leverages, vec![10, 20, 50, 100, 125]);

        // 验证比例总和为 1.0
        let total: f64 = model.get_distribution().values().sum();
        assert!((total - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_round_leverage() {
        assert_eq!(LeverageModel::round_to_standard_leverage(5), 10);
        assert_eq!(LeverageModel::round_to_standard_leverage(18), 20);
        assert_eq!(LeverageModel::round_to_standard_leverage(45), 50);
        assert_eq!(LeverageModel::round_to_standard_leverage(88), 100);
        assert_eq!(LeverageModel::round_to_standard_leverage(125), 125);
    }
}
