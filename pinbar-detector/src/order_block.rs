use crate::types::Candle;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OrderBlock {
    pub ob_type: String, // "bullish" | "bearish"
    pub top: f64,
    pub btm: f64,
    pub time: i64,
    pub source_index: usize,
    pub mitigated: bool,
}

/// Bullish OB: swing low → 突破前一根反向 K 线低点
/// Bearish OB: swing high → 突破前一根反向 K 线高点
pub fn detect_order_blocks(candles: &[Candle], length: usize) -> Vec<OrderBlock> {
    let mut obs: Vec<OrderBlock> = Vec::new();
    if candles.len() <= length + 2 {
        return obs;
    }

    let get_max = |c: &Candle| c.high;
    let get_min = |c: &Candle| c.low;

    for i in (length + 1)..candles.len() {
        let prev = &candles[i - 1];
        let curr = &candles[i];

        // 计算 [i-length, i-1] 区间的最高/最低
        let mut hi = -f64::INFINITY;
        let mut lo = f64::INFINITY;
        for j in (i - length)..i {
            hi = hi.max(get_max(&candles[j]));
            lo = lo.min(get_min(&candles[j]));
        }

        let prior = &candles[i - length - 1];

        // 看跌 OB：当前 K 线收盘跌破 swing low
        if prior.low <= lo && curr.close < lo {
            // 找到 swing low 到当前 K 线之间（不含当前）的最高 K 线
            let mut max_p = -f64::INFINITY;
            let mut min_p = f64::INFINITY;
            let mut src = i - 1;
            for j in (0..i).rev() {
                if j > 0 && j < i {
                    let h = get_max(&candles[j]);
                    if h > max_p {
                        max_p = h;
                        min_p = get_min(&candles[j]);
                        src = j;
                    }
                    if j == 0 || candles[j - 1].low <= lo {
                        break;
                    }
                }
            }
            if max_p > 0.0 {
                obs.push(OrderBlock {
                    ob_type: "bearish".to_string(),
                    top: max_p,
                    btm: min_p,
                    time: candles[src].time,
                    source_index: src,
                    mitigated: false,
                });
            }
        }

        // 看涨 OB：当前 K 线收盘突破 swing high
        if prior.high >= hi && curr.close > hi {
            let mut min_p = f64::INFINITY;
            let mut max_p = -f64::INFINITY;
            let mut src = i - 1;
            for j in (0..i).rev() {
                if j > 0 && j < i {
                    let l = get_min(&candles[j]);
                    if l < min_p {
                        min_p = l;
                        max_p = get_max(&candles[j]);
                        src = j;
                    }
                    if j == 0 || candles[j - 1].high >= hi {
                        break;
                    }
                }
            }
            if min_p < f64::INFINITY {
                obs.push(OrderBlock {
                    ob_type: "bullish".to_string(),
                    top: max_p,
                    btm: min_p,
                    time: candles[src].time,
                    source_index: src,
                    mitigated: false,
                });
            }
        }
    }

    obs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Candle;

    fn c(t: i64, o: f64, h: f64, l: f64, cl: f64) -> Candle {
        Candle { time: t, open: o, high: h, low: l, close: cl, volume: 0.0 }
    }

    #[test]
    fn test_empty() {
        assert!(detect_order_blocks(&[], 5).is_empty());
    }
}
