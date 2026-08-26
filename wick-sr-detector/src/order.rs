//! Binance 下单模块(简化版 — 限价单 + 止损 + 止盈 Algo 单)

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, info, warn};

/// 下单结果
#[derive(Debug, Clone)]
pub struct OrderResult {
    pub order_id: String,
    #[allow(dead_code)]
    pub stop_algo_id: String,
    #[allow(dead_code)]
    pub tp_algo_id: String,
    pub entry_price: f64,
    pub quantity: f64,
}

/// 计算 HMAC-SHA256 签名
///
/// Binance 要求 hex 编码(64 字符),不是 base64。
/// 前端 `api/user/order/route.ts:25` 也是用 hex。
fn sign_query(query: &str, secret: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(query.as_bytes());
    let result = mac.finalize();
    hex::encode(result.into_bytes())
}

/// 交易对精度表(对齐前端 src/app/api/user/order/route.ts:29-44)
/// quantity/price 小数位
const SYMBOL_PRECISION: &[(&str, u32, u32)] = &[
    ("BTCUSDT", 3, 1),
    ("ETHUSDT", 3, 2),
    ("BNBUSDT", 2, 2),
    ("SOLUSDT", 0, 2),
    ("XRPUSDT", 1, 4),
    ("DOGEUSDT", 0, 5),
    ("ADAUSDT", 0, 4),
    ("AVAXUSDT", 1, 2),
    ("DOTUSDT", 1, 3),
    ("LINKUSDT", 1, 3),
    ("MATICUSDT", 0, 4),
    ("LTCUSDT", 2, 2),
    ("BTCUSDC", 3, 1),
    ("ETHUSDC", 3, 2),
];

/// 取 symbol 的 quantity/price 精度,默认 (3, 2)
fn get_precision(symbol: &str) -> (u32, u32) {
    for (s, q, p) in SYMBOL_PRECISION {
        if *s == symbol {
            return (*q, *p);
        }
    }
    (3, 2)
}

/// 格式化数量/价格(对齐前端 toFixed)
fn format_qty(quantity: f64, precision: u32) -> String {
    format!("{:.*}", precision as usize, quantity)
}

/// 验证 SL/TP 价格方向(对齐前端 validateStopPrice,src/app/api/user/order/route.ts:119-152)
/// SL 平多 SELL:stopPrice < currentPrice
/// SL 平空 BUY:stopPrice > currentPrice
/// TP 平多 SELL:stopPrice > currentPrice
/// TP 平空 BUY:stopPrice < currentPrice
fn validate_stop_price(current_price: f64, stop_price: f64, side: &str, order_type: &str) -> bool {
    match order_type {
        "STOP_MARKET" => {
            if side == "SELL" {
                stop_price < current_price
            } else {
                stop_price > current_price
            }
        }
        "TAKE_PROFIT_MARKET" => {
            if side == "SELL" {
                stop_price > current_price
            } else {
                stop_price < current_price
            }
        }
        _ => true,
    }
}

/// 查 symbol 当前价(/fapi/v1/ticker/price),失败返回 None
async fn get_current_price(client: &Client, base_url: &str, symbol: &str) -> Option<f64> {
    let url = format!("{}/fapi/v1/ticker/price?symbol={}", base_url, symbol);
    let resp: serde_json::Value = match client.get(&url).send().await {
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(v) => v,
            Err(_) => return None,
        },
        Err(_) => return None,
    };
    resp.get("price")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
}

/// 单次 Algo 单下单(带 clientAlgoId 字段— Algo API 官方字段名)
/// 返回 Err 时调用方决定是否重试
async fn place_algo_order(
    client: &Client,
    api_key: &str,
    api_secret: &str,
    base_url: &str,
    symbol: &str,
    side: &str,
    position_side: &str,
    order_type: &str,
    quantity: f64,
    price: f64,
    client_order_id: &str,
) -> Result<u64> {
    let (qty_p, price_p) = get_precision(symbol);
    let ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    // Algo 单触发价用 triggerPrice(不是 price)— 对齐前端 route.ts:225
    // Binance 2025-12-09 迁移后强制:STOP_MARKET / TAKE_PROFIT_MARKET 必须用 triggerPrice
    let qs = format!(
        "algoType=CONDITIONAL&symbol={}&side={}&positionSide={}&type={}&\
         quantity={}&triggerPrice={}&clientAlgoId={}&timestamp={}",
        symbol, side, position_side, order_type,
        format_qty(quantity, qty_p), format_qty(price, price_p),
        client_order_id, ts
    );
    let sig = sign_query(&qs, api_secret);
    let url = format!("{}/fapi/v1/algoOrder?{}&signature={}", base_url, qs, sig);

    #[derive(Serialize, Deserialize)]
    struct AlgoResp {
        #[serde(default, rename = "algoId")]
        algo_id: u64,
        #[serde(default)]
        code: i32,
        #[serde(default)]
        msg: String,
    }
    let resp: AlgoResp = client
        .post(&url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
        .context("send algo order")?
        .json()
        .await
        .context("parse algo order")?;
    if resp.code != 0 && resp.algo_id == 0 {
        return Err(anyhow!("algo order failed: code={} msg={}", resp.code, resp.msg));
    }
    Ok(resp.algo_id)
}

/// Algo 单带重试(对齐前端 placeStopOrderWithRetry,默认 3 次 / 500ms)
/// suffix 含 "_sl"/"_tp" 等,重试时变 "_sl_r1"/"_sl_r2"
async fn place_algo_order_with_retry(
    client: &Client,
    api_key: &str,
    api_secret: &str,
    base_url: &str,
    symbol: &str,
    side: &str,
    position_side: &str,
    order_type: &str,
    quantity: f64,
    price: f64,
    client_order_id_prefix: &str,
    suffix: &str,
) -> Option<u64> {
    let max_retries = 2;
    let retry_delay_ms = 500;
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..=max_retries {
        let client_order_id = if attempt == 0 {
            format!("{}{}", client_order_id_prefix, suffix)
        } else {
            format!("{}{}_r{}", client_order_id_prefix, suffix, attempt)
        };
        match place_algo_order(
            client, api_key, api_secret, base_url,
            symbol, side, position_side, order_type,
            quantity, price, &client_order_id,
        ).await {
            Ok(id) => return Some(id),
            Err(e) => {
                warn!("[Algo] {} attempt {} failed: {}", order_type, attempt + 1, e);
                last_err = Some(e);
                if attempt < max_retries {
                    tokio::time::sleep(std::time::Duration::from_millis(retry_delay_ms)).await;
                }
            }
        }
    }
    error!("[Algo] {} all attempts failed: {:?}", order_type, last_err);
    None
}

/// 下限价单(带止损 + 止盈 Algo 单,一次性下三单)
pub async fn place_order_with_sl_tp(
    api_key: &str,
    api_secret: &str,
    base_url: &str,
    symbol: &str,
    side: &str,           // "BUY" / "SELL"
    position_side: &str,  // "LONG" / "SHORT"
    entry_price: f64,
    stop_loss: f64,
    take_profit: f64,
    quantity: f64,
    client_order_id_prefix: &str,
) -> Result<OrderResult> {
    if api_key.is_empty() || api_secret.is_empty() {
        return Err(anyhow!("BINANCE_API_KEY/SECRET 未配置,跳过下单"));
    }

    let client = Client::new();

    // 0) 取当前价(用于 SL/TP 方向校验)— 失败也不阻塞主单,只是不下 SL/TP
    let current_price = get_current_price(&client, base_url, symbol).await;
    if current_price.is_none() {
        warn!("[Order] 无法获取当前价,跳过 SL/TP 下单(主单照下)");
    }

    // 1) 下限价单(入场)— 同步单次(不重试)
    let (qty_p, price_p) = get_precision(symbol);
    let entry_ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let entry_qs = format!(
        "symbol={}&side={}&positionSide={}&type=LIMIT&timeInForce=GTC&\
         quantity={}&price={}&newClientOrderId={}_entry&timestamp={}",
        symbol, side, position_side,
        format_qty(quantity, qty_p), format_qty(entry_price, price_p),
        client_order_id_prefix, entry_ts
    );
    let entry_sig = sign_query(&entry_qs, api_secret);
    let entry_url = format!("{}/fapi/v1/order?{}&signature={}", base_url, entry_qs, entry_sig);

    #[derive(Serialize, Deserialize)]
    struct EntryResp {
        #[serde(default, rename = "orderId")]
        order_id: u64,
        #[serde(default)]
        code: i32,
        #[serde(default)]
        msg: String,
    }
    let entry_resp: EntryResp = client
        .post(&entry_url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
        .context("send entry order")?
        .json()
        .await
        .context("parse entry order")?;
    if entry_resp.code != 0 && entry_resp.order_id == 0 {
        return Err(anyhow!("entry order failed: code={} msg={}", entry_resp.code, entry_resp.msg));
    }
    info!("[Order] entry OK orderId={}", entry_resp.order_id);

    // 2) 止损 Algo + 3) 止盈 Algo — 共享 stop_side(SL/TP 都是平仓方向)
    let stop_side = if side == "BUY" { "SELL" } else { "BUY" };
    let entry_order_id = entry_resp.order_id.to_string();

    // 2) 止损 Algo
    let stop_algo_id = match current_price {
        Some(cp) if !validate_stop_price(cp, stop_loss, stop_side, "STOP_MARKET") => {
            warn!(
                "[Order] SL 价格方向无效,跳过: currentPrice={} stopLoss={} side={}",
                cp, stop_loss, stop_side
            );
            String::new()
        }
        _ => {
            place_algo_order_with_retry(
                &client, api_key, api_secret, base_url,
                symbol, stop_side, position_side, "STOP_MARKET",
                quantity, stop_loss, &entry_order_id, "_sl",
            ).await
                .map(|id| id.to_string())
                .unwrap_or_default()
        }
    };

    // 3) 止盈 Algo
    let tp_algo_id = match current_price {
        Some(cp) if !validate_stop_price(cp, take_profit, stop_side, "TAKE_PROFIT_MARKET") => {
            warn!(
                "[Order] TP 价格方向无效,跳过: currentPrice={} takeProfit={} side={}",
                cp, take_profit, stop_side
            );
            String::new()
        }
        _ => {
            place_algo_order_with_retry(
                &client, api_key, api_secret, base_url,
                symbol, stop_side, position_side, "TAKE_PROFIT_MARKET",
                quantity, take_profit, &entry_order_id, "_tp",
            ).await
                .map(|id| id.to_string())
                .unwrap_or_default()
        }
    };

    Ok(OrderResult {
        order_id: entry_resp.order_id.to_string(),
        stop_algo_id,
        tp_algo_id,
        entry_price,
        quantity,
    })
}

/// 计算下单数量(USDC 永续)
///
/// `quantity = balance * pct / entry_price` — 这是按 1x 名义算出的"裸数量"。
/// 计算下单数量(USDC 永续)
///
/// `quantity = balance * pct * leverage / entry_price`
///
/// **占用保证金 = balance × pct**(跟 1x/100x 无关,只跟仓位百分比有关),
/// 但 quantity 本身已经按 leverage 放大 — 也就是说**名义价值 = balance × pct × leverage**。
///
/// 示例:balance = 1000, pct = 0.5, BTC = 60000, leverage = 100
/// - quantity = 1000 × 0.5 × 100 / 60000 = 0.8333 BTC
/// - 名义价值 = 0.8333 × 60000 = 50000 USDC
/// - 保证金 = 50000 / 100 = 500 USDC = balance × pct ✅
///
/// **杠杆:本程序不调用 `/fapi/v1/leverage` 修改用户设置**,实际 leverage 由调用方传入
/// (main.rs 通过 `get_leverage` 读 `/fapi/v2/positionRisk` 拿,fallback 100x)。
pub fn calculate_quantity(
    wallet_balance: f64,
    position_pct: f64,
    leverage: u32,
    entry_price: f64,
) -> f64 {
    if wallet_balance <= 0.0 || entry_price <= 0.0 || leverage == 0 {
        return 0.0;
    }
    (wallet_balance * position_pct * leverage as f64) / entry_price
}

/// 查账户 USDT/USDC 余额(从 /fapi/v2/account 读 availableBalance)
pub async fn get_account_balance(
    api_key: &str,
    api_secret: &str,
    base_url: &str,
    asset: &str,
) -> f64 {
    if api_key.is_empty() || api_secret.is_empty() {
        return 0.0;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let qs = format!("timestamp={}", ts);
    let sig = sign_query(&qs, api_secret);
    let url = format!("{}/fapi/v2/account?{}&signature={}", base_url, qs, sig);

    let client = Client::new();
    let resp: serde_json::Value = match client
        .get(&url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
    {
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(v) => v,
            Err(_) => return 0.0,
        },
        Err(e) => {
            warn!("[Account] request failed: {}", e);
            return 0.0;
        }
    };

    if let Some(assets) = resp.get("assets").and_then(|x| x.as_array()) {
        for a in assets {
            if a.get("asset").and_then(|x| x.as_str()) == Some(asset) {
                if let Some(b) = a.get("availableBalance").and_then(|x| x.as_str()) {
                    return b.parse().unwrap_or(0.0);
                }
            }
        }
    }
    0.0
}

/// 取消 symbol 的所有挂单(简化,API 不带 algoType)
#[allow(dead_code)]
pub async fn cancel_all_orders(api_key: &str, api_secret: &str, base_url: &str, symbol: &str) -> Result<()> {
    if api_key.is_empty() || api_secret.is_empty() {
        return Ok(());
    }
    let ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let qs = format!("symbol={}&timestamp={}", symbol, ts);
    let sig = sign_query(&qs, api_secret);
    let url = format!("{}/fapi/v1/allOpenOrders?{}&signature={}", base_url, qs, sig);

    let client = Client::new();
    client
        .delete(&url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
        .context("cancel all orders")?;
    info!("[Order] cancelled all open orders for {}", symbol);
    Ok(())
}

/// 查 symbol 当前杠杆(从 /fapi/v2/positionRisk 读)
///
/// 为什么不调 `/fapi/v1/leverage`:那个 endpoint 只在用户之前调过 `POST /fapi/v1/leverage`
/// 设置过 leverage 时才有数据,否则 -4028 报错("User's position settings of the symbol does not exist")。
/// `/fapi/v2/positionRisk` 返回所有 symbol 的持仓信息(包括零持仓的),从里面找 leverage 更可靠。
///
/// 返回 `None` 表示未配 API key;其他情况总会返回 leverage(找不到时默认 20x,
/// 跟前端 `/api/user/leverage` 的 fallback 行为一致)。
pub async fn get_leverage(
    api_key: &str,
    api_secret: &str,
    base_url: &str,
    symbol: &str,
) -> Option<u32> {
    if api_key.is_empty() || api_secret.is_empty() {
        return None;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let qs = format!("timestamp={}", ts);
    let sig = sign_query(&qs, api_secret);
    let url = format!("{}/fapi/v2/positionRisk?{}&signature={}", base_url, qs, sig);

    let client = Client::new();
    let resp: serde_json::Value = match client
        .get(&url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
    {
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(v) => v,
            Err(e) => {
                warn!("[Leverage] parse failed: {}", e);
                return Some(20);  // 失败也默认 20x(跟前端一致)
            }
        },
        Err(e) => {
            warn!("[Leverage] request failed: {}", e);
            return Some(20);
        }
    };
    // positionRisk 返回所有持仓数组,从里面找 symbol 匹配的条目,读 leverage
    if let Some(arr) = resp.as_array() {
        for p in arr {
            if p.get("symbol").and_then(|v| v.as_str()) == Some(symbol) {
                if let Some(lev) = p.get("leverage").and_then(|v| v.as_u64()) {
                    return Some(lev as u32);
                }
            }
        }
    }
    // 没找到 → 默认 20x(Binance USDⓈ-M 永续默认 leverage)
    Some(20)
}

/// 查当前监控 symbol 的持仓条数(从 /fapi/v2/positionRisk 数 positionAmt.abs() > 0)
///
/// 口径:仅数 `symbol == X && positionAmt.abs() > 0` 的条目数。
/// - hedge 模式:LONG + SHORT 可同时 > 0 → 返回 0/1/2
/// - one-way 模式:任一时刻只能有一个方向有仓位 → 返回 0/1
///
/// 失败兜底:未配 key / 网络失败 / JSON 解析失败时返回 0(放行),
/// 不要因为查不到而误杀(宁可多下一单,不要少下一单)。
pub async fn get_position_count(
    api_key: &str,
    api_secret: &str,
    base_url: &str,
    symbol: &str,
) -> u32 {
    if api_key.is_empty() || api_secret.is_empty() {
        return 0;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let qs = format!("timestamp={}", ts);
    let sig = sign_query(&qs, api_secret);
    let url = format!("{}/fapi/v2/positionRisk?{}&signature={}", base_url, qs, sig);

    let client = Client::new();
    let resp: serde_json::Value = match client
        .get(&url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
    {
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(v) => v,
            Err(e) => {
                warn!("[PositionCount] parse failed: {}", e);
                return 0;
            }
        },
        Err(e) => {
            warn!("[PositionCount] request failed: {}", e);
            return 0;
        }
    };

    let mut count: u32 = 0;
    if let Some(arr) = resp.as_array() {
        for p in arr {
            if p.get("symbol").and_then(|v| v.as_str()) != Some(symbol) {
                continue;
            }
            // positionAmt 是字符串(如 "0.001" / "-0.5" / "0"),必须 as_str + parse
            if let Some(amt_str) = p.get("positionAmt").and_then(|v| v.as_str()) {
                if let Ok(amt) = amt_str.parse::<f64>() {
                    if amt.abs() > 0.0 {
                        count += 1;
                    }
                }
            }
        }
    }
    count
}

/// 查 symbol 当前 positionAmt 数值(返回 f64,None 表示 API 失败)
/// 用于孤儿清理的判定
pub async fn get_position_amount(
    api_key: &str,
    api_secret: &str,
    base_url: &str,
    symbol: &str,
) -> Option<f64> {
    if api_key.is_empty() || api_secret.is_empty() {
        return None;
    }
    let ts = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis()).unwrap_or(0);
    let qs = format!("timestamp={}", ts);
    let sig = sign_query(&qs, api_secret);
    let url = format!("{}/fapi/v2/positionRisk?{}&signature={}", base_url, qs, sig);

    let client = Client::new();
    let resp: serde_json::Value = match client.get(&url)
        .header("X-MBX-APIKEY", api_key).send().await
    {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(_) => return None,
        },
        Err(_) => return None,
    };

    if let Some(arr) = resp.as_array() {
        for p in arr {
            if p.get("symbol").and_then(|v| v.as_str()) != Some(symbol) {
                continue;
            }
            if let Some(amt_str) = p.get("positionAmt").and_then(|v| v.as_str()) {
                if let Ok(amt) = amt_str.parse::<f64>() {
                    return Some(amt);
                }
            }
        }
    }
    None
}

/// Algo 单信息(供孤儿清理 age 判定用)
#[derive(Debug, Clone)]
pub struct AlgoOrder {
    pub algo_id: u64,
    pub client_algo_id: String,
    /// Binance 上 Algo 单的创建时间(unix ms)— 用真实时间判定 age
    pub create_time_ms: i64,
}

/// 查所有 openAlgoOrders,返回 (algo_id, client_algo_id, create_time_ms)
/// 用于孤儿清理:用 Binance 真实 create_time 算 age,不依赖本程序 round 计数
pub async fn list_open_algo_orders(
    api_key: &str,
    api_secret: &str,
    base_url: &str,
) -> Result<Vec<AlgoOrder>> {
    if api_key.is_empty() || api_secret.is_empty() {
        return Ok(Vec::new());
    }
    let ts = SystemTime::now().duration_since(UNIX_EPOCH)?
        .as_millis();
    let qs = format!("timestamp={}", ts);
    let sig = sign_query(&qs, api_secret);
    let url = format!("{}/fapi/v1/openAlgoOrders?{}&signature={}", base_url, qs, sig);

    let client = Client::new();
    let resp: serde_json::Value = match client.get(&url)
        .header("X-MBX-APIKEY", api_key).send().await
    {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(e) => return Err(anyhow!("parse openAlgoOrders: {}", e)),
        },
        Err(e) => return Err(anyhow!("request openAlgoOrders: {}", e)),
    };

    let mut algos = Vec::new();
    if let Some(arr) = resp.as_array() {
        for a in arr {
            let algo_id = match a.get("algoId").and_then(|v| v.as_u64()) {
                Some(id) => id,
                None => continue,
            };
            let client_algo_id = a.get("clientAlgoId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // createTime 是 unix 毫秒
            let create_time_ms = a.get("createTime")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            algos.push(AlgoOrder {
                algo_id,
                client_algo_id,
                create_time_ms,
            });
        }
    }
    Ok(algos)
}

/// 取消单个 Algo 单
pub async fn cancel_single_algo(
    api_key: &str,
    api_secret: &str,
    base_url: &str,
    symbol: &str,
    algo_id: u64,
) -> Result<bool> {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let qs = format!("symbol={}&algoId={}&timestamp={}", symbol, algo_id, ts);
    let sig = sign_query(&qs, api_secret);
    let url = format!("{}/fapi/v1/algoOrder?{}&signature={}", base_url, qs, sig);

    let client = Client::new();
    let resp: serde_json::Value = client.delete(&url)
        .header("X-MBX-APIKEY", api_key)
        .send().await
        .context("cancel algo")?
        .json().await
        .context("parse cancel resp")?;
    Ok(resp.get("code").and_then(|v| v.as_i64()).unwrap_or(-1) == 0)
}
///
/// 场景:
/// - 下单时 SL/TP 因为 validate_stop_price / -1106 / 重试 3 次失败等没挂上
/// - Algo 被外部误清(用户手动 / 其他脚本)
/// - 启动前已有的持仓没有保护单
///
/// 逻辑:
/// 1. 查 /fapi/v2/positionRisk 拿所有持仓(positionAmt != 0)
/// 2. 查 /fapi/v1/openAlgoOrders 拿所有 Algo 单
/// 3. 对每个有持仓的 symbol:
///    - 没 SL Algo(同 symbol + positionSide + STOP_MARKET)→ 下 SL(stop_price = entry ± default_stop_usd)
///    - 没 TP Algo → 下 TP
///
/// 返回补的 Algo 数量(0 = 都已有保护)。
pub async fn ensure_protective_orders(
    api_key: &str,
    api_secret: &str,
    base_url: &str,
    default_stop_usd: f64,
    default_tp_usd: f64,
) -> Result<u32> {
    if api_key.is_empty() || api_secret.is_empty() {
        return Ok(0);
    }

    let client = Client::new();

    // 1) 查 positionRisk
    let ts = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis()).unwrap_or(0);
    let pr_qs = format!("timestamp={}", ts);
    let pr_sig = sign_query(&pr_qs, api_secret);
    let pr_url = format!("{}/fapi/v2/positionRisk?{}&signature={}", base_url, pr_qs, pr_sig);

    let pr_resp: serde_json::Value = match client.get(&pr_url)
        .header("X-MBX-APIKEY", api_key).send().await
    {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(_) => return Ok(0),
        },
        Err(_) => return Ok(0),
    };

    // 收集有持仓的:(symbol, positionSide, entry_price, amt)
    let mut positions: Vec<(String, String, f64, f64)> = Vec::new();
    if let Some(arr) = pr_resp.as_array() {
        for p in arr {
            let symbol = match p.get("symbol").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let amt_str = match p.get("positionAmt").and_then(|v| v.as_str()) {
                Some(s) => s,
                None => continue,
            };
            let amt = match amt_str.parse::<f64>() {
                Ok(v) => v,
                Err(_) => continue,
            };
            if amt.abs() < 0.0001 {
                continue;
            }
            let entry = p.get("entryPrice").and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
            let position_side = if amt > 0.0 { "LONG" } else { "SHORT" };
            positions.push((symbol, position_side.to_string(), entry, amt));
        }
    }
    if positions.is_empty() {
        return Ok(0);
    }

    // 2) 查 openAlgoOrders
    let algo_ts = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis()).unwrap_or(0);
    let algo_qs = format!("timestamp={}", algo_ts);
    let algo_sig = sign_query(&algo_qs, api_secret);
    let algo_url = format!("{}/fapi/v1/openAlgoOrders?{}&signature={}", base_url, algo_qs, algo_sig);
    let algo_resp: serde_json::Value = match client.get(&algo_url)
        .header("X-MBX-APIKEY", api_key).send().await
    {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(_) => serde_json::json!([]),
        },
        Err(_) => serde_json::json!([]),
    };

    // 收集已有 Algo 单(按 symbol|type → triggerPrice 列表,**不依赖 positionSide 字段**)
// 收集所有 Algo 单的 triggerPrice(不分 type,因为 Binance 返回的 type 字段可能为空/缺失)
    // SL/TP 分类在持仓循环内根据 triggerPrice 跟 entry 的位置关系判定:
    // - LONG 仓:triggerPrice < entry → SL,triggerPrice > entry → TP
    // - SHORT 仓:triggerPrice > entry → SL,triggerPrice < entry → TP
    let mut existing: std::collections::HashMap<String, Vec<f64>> = std::collections::HashMap::new();
    let mut algo_count: u32 = 0;
    if let Some(arr) = algo_resp.as_array() {
        for a in arr {
            let symbol = a.get("symbol").and_then(|v| v.as_str()).unwrap_or("");
            let position_side = a.get("positionSide").and_then(|v| v.as_str()).unwrap_or("?");
            let algo_id = a.get("algoId").and_then(|v| v.as_u64()).unwrap_or(0);
            let client_algo_id = a.get("clientAlgoId").and_then(|v| v.as_str()).unwrap_or("");
            let trigger_price_raw = a.get("triggerPrice");
            let trigger_price = trigger_price_raw
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
            // key 用 symbol(忽略 type,因为 type 字段可能缺失)
            let key = symbol.to_string();
            algo_count += 1;
            existing.entry(key).or_insert_with(Vec::new).push(trigger_price);
            debug!(
                "[Protect] Algo 单: algoId={} clientAlgoId={} symbol={} positionSide={} triggerPrice={}",
                algo_id, client_algo_id, symbol, position_side, trigger_price
            );
        }
    }
    if algo_count > 0 {
        info!("[Protect] 读到 {} 个 Algo 单(用于判定已有保护)", algo_count);
    }

    // 价格容忍度:跟 entry 距离 ≤ max(default_stop_usd, default_tp_usd) * 1.5
    // 默认 200 → tolerance = 300 USD。即:同一 symbol 附近 300 USD 内已有同 type Algo → 算"有"
    let tolerance = (default_stop_usd.max(default_tp_usd)) * 1.5;

    // 3) 对每个持仓补 SL/TP
    let mut placed: u32 = 0;
    for (symbol, position_side, entry, amt) in positions {
        if entry <= 0.0 {
            warn!("[Protect] {} {} entry_price=0,跳过(可能刚开仓未更新)", symbol, position_side);
            continue;
        }
        let side = if amt > 0.0 { "BUY" } else { "SELL" };
        let stop_side = if side == "BUY" { "SELL" } else { "BUY" };
        let quantity = amt.abs();

        // 不依赖 type 字段(可能缺失),按 triggerPrice 跟 entry 的位置分类:
        // - LONG 仓:triggerPrice < entry → SL,triggerPrice > entry → TP
        // - SHORT 仓:triggerPrice > entry → SL,triggerPrice < entry → TP
        let prices = existing.get(&symbol).cloned().unwrap_or_default();
        let has_sl = if position_side == "LONG" {
            prices.iter().any(|&p| p > 0.0 && p < entry && (entry - p).abs() <= tolerance)
        } else {
            prices.iter().any(|&p| p > 0.0 && p > entry && (p - entry).abs() <= tolerance)
        };
        let has_tp = if position_side == "LONG" {
            prices.iter().any(|&p| p > 0.0 && p > entry && (p - entry).abs() <= tolerance)
        } else {
            prices.iter().any(|&p| p > 0.0 && p < entry && (entry - p).abs() <= tolerance)
        };
        // 诊断:为什么判定 false
        if !has_sl {
            // 诊断:为什么判定 false
            if !prices.is_empty() {
                let dists: Vec<String> = prices.iter()
                    .map(|&p| {
                        let pos = if position_side == "LONG" {
                            if p < entry { "below_entry" } else { "above_entry" }
                        } else {
                            if p > entry { "above_entry" } else { "below_entry" }
                        };
                        format!("${:.2}(dist=${:.0},{})", p, (p - entry).abs(), pos)
                    })
                    .collect();
                warn!(
                    "[Protect] {} {} SL 判定 false: entry={} tolerance={} 已有 triggerPrices=[{}]",
                    symbol, position_side, entry, tolerance, dists.join(", ")
                );
            } else {
                warn!("[Protect] {} {} SL 判定 false: 没有任何 Algo 单", symbol, position_side);
            }
        }
        if !has_sl {
            let stop_price = if position_side == "LONG" {
                entry - default_stop_usd
            } else {
                entry + default_stop_usd
            };
            // clientOrderId 加时间戳(秒级)避免重复 -4116;
            // 同时要 < 36 字符(Binance 限制)— 用短前缀 + ts_secs
            // 格式: p_{symbol}_{L_or_S}_{type}_{ts_secs}
            // 例: p_BTCUSDC_L_sl_1787733900 (25 字符)
            let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            let side_short = if position_side == "LONG" { "L" } else { "S" };
            let client_order_id = format!("p_{}_{}_sl_{}", symbol, side_short, now_secs);
            match place_algo_order(
                &client, api_key, api_secret, base_url,
                &symbol, stop_side, &position_side, "STOP_MARKET",
                quantity, stop_price, &client_order_id,
            ).await {
                Ok(id) => {
                    info!("[Protect] {} {} SL 补单: algoId={} stop_price={} clientAlgoId={}",
                        symbol, position_side, id, stop_price, client_order_id);
                    placed += 1;
                }
                Err(e) => warn!("[Protect] {} {} SL 补单失败: {}", symbol, position_side, e),
            }
        }

        // TP
        if !has_tp {
            let tp_price = if position_side == "LONG" {
                entry + default_tp_usd
            } else {
                entry - default_tp_usd
            };
            let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            let side_short = if position_side == "LONG" { "L" } else { "S" };
            let client_order_id = format!("p_{}_{}_tp_{}", symbol, side_short, now_secs);
            match place_algo_order(
                &client, api_key, api_secret, base_url,
                &symbol, stop_side, &position_side, "TAKE_PROFIT_MARKET",
                quantity, tp_price, &client_order_id,
            ).await {
                Ok(id) => {
                    info!("[Protect] {} {} TP 补单: algoId={} tp_price={} clientAlgoId={}",
                        symbol, position_side, id, tp_price, client_order_id);
                    placed += 1;
                }
                Err(e) => warn!("[Protect] {} {} TP 补单失败: {}", symbol, position_side, e),
            }
        }
    }

    Ok(placed)
}
