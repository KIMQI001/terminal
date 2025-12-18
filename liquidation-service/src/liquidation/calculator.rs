/// Binance 维持保证金率 (根据持仓量不同有所不同，这里用通用值)
const DEFAULT_MMR: f64 = 0.004; // 0.4%

/// 计算清算价格
///
/// # Arguments
/// * `entry_price` - 入场价格
/// * `leverage` - 杠杆倍数
/// * `is_long` - 是否做多
/// * `mmr` - 维持保证金率 (可选，默认 0.4%)
///
/// # Returns
/// 清算价格
pub fn calc_liquidation_price(entry_price: f64, leverage: u32, is_long: bool, mmr: Option<f64>) -> f64 {
    let mmr = mmr.unwrap_or(DEFAULT_MMR);

    if is_long {
        // 做多清算价 = 入场价 × (1 - 1/杠杆 + 维持保证金率)
        entry_price * (1.0 - 1.0 / leverage as f64 + mmr)
    } else {
        // 做空清算价 = 入场价 × (1 + 1/杠杆 - 维持保证金率)
        entry_price * (1.0 + 1.0 / leverage as f64 - mmr)
    }
}

/// 从清算价和入场价反推杠杆倍数
///
/// # Arguments
/// * `entry_price` - 入场价格
/// * `liq_price` - 清算价格
/// * `is_long` - 是否做多
///
/// # Returns
/// 估算的杠杆倍数
pub fn estimate_leverage(entry_price: f64, liq_price: f64, is_long: bool) -> u32 {
    let diff_ratio = (entry_price - liq_price).abs() / entry_price;

    // 杠杆 ≈ 1 / diff_ratio (忽略维持保证金率的影响)
    let estimated = (1.0 / diff_ratio).round() as u32;

    // 限制在合理范围内
    estimated.clamp(1, 125)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_long_liquidation_price() {
        // 100000 入场，20x 杠杆做多
        // 清算价 ≈ 100000 * (1 - 1/20 + 0.004) = 100000 * 0.954 = 95400
        let liq_price = calc_liquidation_price(100000.0, 20, true, None);
        assert!((liq_price - 95400.0).abs() < 100.0);
    }

    #[test]
    fn test_short_liquidation_price() {
        // 100000 入场，20x 杠杆做空
        // 清算价 ≈ 100000 * (1 + 1/20 - 0.004) = 100000 * 1.046 = 104600
        let liq_price = calc_liquidation_price(100000.0, 20, false, None);
        assert!((liq_price - 104600.0).abs() < 100.0);
    }

    #[test]
    fn test_estimate_leverage() {
        // 从 100000 入场，95000 清算反推
        let leverage = estimate_leverage(100000.0, 95000.0, true);
        assert_eq!(leverage, 20);
    }
}
