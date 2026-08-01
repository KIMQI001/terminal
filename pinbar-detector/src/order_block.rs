use crate::types::Candle;

/// Order Block detected using LuxAlgo-style pivot detection.
/// This mirrors src/lib/chart/indicators/orderBlocks.ts in the frontend.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OrderBlock {
    pub ob_type: String, // "bullish" | "bearish"
    pub top: f64,
    pub btm: f64,
    pub time: i64,
    pub source_index: usize,
    pub mitigated: bool,
}

const SWING_LENGTH: usize = 10;

/// TradingView ta.pivothigh equivalent: check left + right
fn ta_pivothigh(candles: &[Candle], i: usize, length: usize) -> Option<f64> {
    if i < length {
        return None;
    }
    let is_high = candles[i].high;
    // left
    for j in 1..=length {
        if candles[i - j].high > is_high {
            return None;
        }
    }
    // right (only confirm bars that have already arrived)
    for j in 1..length {
        if i + j < candles.len() && candles[i + j].high >= is_high {
            return None;
        }
    }
    Some(is_high)
}

fn ta_pivotlow(candles: &[Candle], i: usize, length: usize) -> Option<f64> {
    if i < length {
        return None;
    }
    let is_low = candles[i].low;
    for j in 1..=length {
        if candles[i - j].low < is_low {
            return None;
        }
    }
    for j in 1..length {
        if i + j < candles.len() && candles[i + j].low <= is_low {
            return None;
        }
    }
    Some(is_low)
}

#[derive(Debug, Clone)]
struct Swing {
    price: f64,
    index: usize,
    time: i64,
    crossed: bool,
}

/// Detects Order Blocks.
/// Tracks swing highs / lows via os-state (LuxAlgo convention).
/// Mirrors the frontend detectOrderBlocks() function exactly.
pub fn detect_order_blocks(candles: &[Candle]) -> Vec<OrderBlock> {
    if candles.len() < SWING_LENGTH + 10 {
        return Vec::new();
    }

    let get_max = |c: &Candle| c.high;
    let get_min = |c: &Candle| c.low;

    let mut bullish_obs: Vec<OrderBlock> = Vec::new();
    let mut bearish_obs: Vec<OrderBlock> = Vec::new();

    let mut os: i32 = 0;
    let mut top_swing: Option<Swing> = None;
    let mut btm_swing: Option<Swing> = None;

    for i in SWING_LENGTH..candles.len() {
        let candle = &candles[i];
        let candle_at_len = &candles[i - SWING_LENGTH];

        // upper = max high in (i - length, i-1]
        let mut upper = f64::NEG_INFINITY;
        let mut lower = f64::INFINITY;
        for j in (i - SWING_LENGTH + 1)..i {
            upper = upper.max(get_max(&candles[j]));
            lower = lower.min(get_min(&candles[j]));
        }

        let prev_os = os;
        if candle_at_len.high > upper {
            os = 0;
        } else if candle_at_len.low < lower {
            os = 1;
        }

        if os == 0 && prev_os != 0 {
            top_swing = Some(Swing {
                price: candle_at_len.high,
                index: i - SWING_LENGTH,
                time: candle_at_len.time,
                crossed: false,
            });
        }
        if os == 1 && prev_os != 1 {
            btm_swing = Some(Swing {
                price: candle_at_len.low,
                index: i - SWING_LENGTH,
                time: candle_at_len.time,
                crossed: false,
            });
        }

        // Bullish OB: price breaks above swing high
        if let Some(ts) = top_swing.as_ref() {
            if !ts.crossed && candle.close > ts.price {
                let ts_idx = ts.index;
                let mut maxima = get_max(&candles[i - 1]);
                let mut minima = get_min(&candles[i - 1]);
                let mut loc_index = i - 1;
                for j in 1..(i - ts_idx) {
                    let idx = i - j;
                    if idx <= ts_idx {
                        break;
                    }
                    let mn = get_min(&candles[idx]);
                    if mn < minima {
                        minima = mn;
                        maxima = get_max(&candles[idx]);
                        loc_index = idx;
                    }
                }
                bullish_obs.insert(
                    0,
                    OrderBlock {
                        ob_type: "bullish".to_string(),
                        top: maxima,
                        btm: minima,
                        time: candles[loc_index].time,
                        source_index: loc_index,
                        mitigated: false,
                    },
                );
                top_swing.as_mut().unwrap().crossed = true;
            }
        }

        // Bearish OB: price breaks below swing low
        if let Some(bs) = btm_swing.as_ref() {
            if !bs.crossed && candle.close < bs.price {
                let bs_idx = bs.index;
                let mut maxima = get_min(&candles[i - 1]);
                let mut minima = get_max(&candles[i - 1]);
                let mut loc_index = i - 1;
                for j in 1..(i - bs_idx) {
                    let idx = i - j;
                    if idx <= bs_idx {
                        break;
                    }
                    let mx = get_max(&candles[idx]);
                    if mx > maxima {
                        maxima = mx;
                        minima = get_min(&candles[idx]);
                        loc_index = idx;
                    }
                }
                bearish_obs.insert(
                    0,
                    OrderBlock {
                        ob_type: "bearish".to_string(),
                        top: maxima,
                        btm: minima,
                        time: candles[loc_index].time,
                        source_index: loc_index,
                        mitigated: false,
                    },
                );
                btm_swing.as_mut().unwrap().crossed = true;
            }
        }

        // Mitigation checks
        for j in (0..bullish_obs.len()).rev() {
            let ob = bullish_obs[j].clone();
            if !ob.mitigated {
                if candle.open.min(candle.close) < ob.btm {
                    bullish_obs[j].mitigated = true;
                }
            } else if candle.close > ob.top {
                bullish_obs.remove(j);
            }
        }
        for j in (0..bearish_obs.len()).rev() {
            let ob = bearish_obs[j].clone();
            if !ob.mitigated {
                if candle.open.max(candle.close) > ob.top {
                    bearish_obs[j].mitigated = true;
                }
            } else if candle.close < ob.btm {
                bearish_obs.remove(j);
            }
        }
    }

    bullish_obs.extend(bearish_obs);
    bullish_obs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Candle;

    fn c(t: i64, o: f64, h: f64, l: f64, cl: f64) -> Candle {
        Candle {
            time: t,
            open: o,
            high: h,
            low: l,
            close: cl,
            volume: 0.0,
        }
    }

    #[test]
    fn test_empty() {
        assert!(detect_order_blocks(&[]).is_empty());
    }

    #[test]
    fn test_short_data() {
        let candles = vec![c(1, 100.0, 110.0, 90.0, 105.0); 5];
        assert!(detect_order_blocks(&candles).is_empty());
    }
}