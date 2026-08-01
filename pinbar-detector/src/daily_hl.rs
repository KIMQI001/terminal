//! 历史日 K 高低点扫描
//! 用于判断 15m OB 是否包含某个日 K 的 high/low 极值

/// 一条历史日 K 上的 high/low 极值命中
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DailyHlHit {
    pub hl_type: String,   // "H" | "L"
    pub price: f64,
    pub daily_time: i64,    // 日 K 起始时间
}

/// 检查一个 OB 是否"包裹"了历史日 K 的 high/low 极值
///
/// 完全包裹：OB.top > hl.price AND OB.btm < hl.price
pub fn find_overlapped_hl(
    ob_top: f64,
    ob_btm: f64,
    daily_candles: &[(i64, f64, f64, f64, f64, f64)],
) -> Vec<DailyHlHit> {
    let mut hits = Vec::new();
    for (time, _open, high, low, _close, _vol) in daily_candles {
        if ob_top > *high && ob_btm < *high {
            hits.push(DailyHlHit {
                hl_type: "H".to_string(),
                price: *high,
                daily_time: *time,
            });
        }
        if ob_top > *low && ob_btm < *low {
            hits.push(DailyHlHit {
                hl_type: "L".to_string(),
                price: *low,
                daily_time: *time,
            });
        }
    }
    hits
}