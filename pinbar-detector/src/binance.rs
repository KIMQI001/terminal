//! Binance API 封装
//! 用于下单、取消订单、获取余额等

use serde::{Deserialize, Serialize};
use std::env;

#[derive(Debug, Clone)]
pub struct BinanceConfig {
    pub api_key: String,
    pub api_secret: String,
    pub is_testnet: bool,
}

impl BinanceConfig {
    pub fn from_env() -> Option<Self> {
        let api_key = env::var("BINANCE_API_KEY").ok()?;
        let api_secret = env::var("BINANCE_API_SECRET").ok()?;
        let is_testnet = env::var("BINANCE_TESTNET").map(|v| v == "true").unwrap_or(false);
        Some(Self { api_key, api_secret, is_testnet })
    }

    pub fn base_url(&self) -> &str {
        if self.is_testnet {
            "https://testnet.binancefuture.com"
        } else {
            "https://fapi.binance.com"
        }
    }
}

fn generate_signature(query_string: &str, secret: &str) -> String {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(query_string.as_bytes());
    let result = mac.finalize();
    hex::encode(result.into_bytes())
}

#[derive(Debug, Serialize)]
struct QueryParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    position_side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    order_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quantity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    time_in_force: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reduce_only: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_client_order_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    algo_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trigger_price: Option<String>,
}

impl QueryParams {
    fn to_query_string(&self) -> String {
        let mut pairs = Vec::new();
        if let Some(v) = &self.symbol { pairs.push(format!("symbol={}", v)); }
        if let Some(v) = &self.side { pairs.push(format!("side={}", v)); }
        if let Some(v) = &self.position_side { pairs.push(format!("positionSide={}", v)); }
        if let Some(v) = &self.order_type { pairs.push(format!("type={}", v)); }
        if let Some(v) = &self.quantity { pairs.push(format!("quantity={}", v)); }
        if let Some(v) = &self.price { pairs.push(format!("price={}", v)); }
        if let Some(v) = &self.stop_price { pairs.push(format!("stopPrice={}", v)); }
        if let Some(v) = &self.time_in_force { pairs.push(format!("timeInForce={}", v)); }
        if let Some(v) = &self.timestamp { pairs.push(format!("timestamp={}", v)); }
        if let Some(v) = &self.reduce_only { pairs.push(format!("reduceOnly={}", v)); }
        if let Some(v) = &self.new_client_order_id { pairs.push(format!("newClientOrderId={}", v)); }
        if let Some(v) = &self.algo_type { pairs.push(format!("algoType={}", v)); }
        if let Some(v) = &self.trigger_price { pairs.push(format!("triggerPrice={}", v)); }
        pairs.join("&")
    }
}

#[derive(Debug, Deserialize)]
struct BinanceResponse {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    msg: Option<String>,
    #[serde(default)]
    #[serde(rename = "orderId")]
    order_id: Option<u64>,
    #[serde(default)]
    #[serde(rename = "clientOrderId")]
    client_order_id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    #[serde(rename = "algoId")]
    algo_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BalanceAsset {
    asset: String,
    #[serde(rename = "walletBalance")]
    wallet_balance: String,
    #[serde(rename = "availableBalance")]
    available_balance: String,
}

#[derive(Debug, Deserialize)]
struct BalanceResponse {
    assets: Option<Vec<BalanceAsset>>,
}

#[derive(Debug, Deserialize)]
pub struct OpenOrderInfo {
    #[serde(rename = "orderId")]
    pub order_id: u64,
    pub symbol: String,
    #[serde(rename = "clientOrderId")]
    pub client_order_id: String,
    pub side: String,
    #[serde(rename = "positionSide")]
    pub position_side: String,
    #[serde(rename = "origQty")]
    pub orig_qty: String,
    pub price: String,
    #[serde(rename = "type")]
    pub order_type: String,
    pub status: String,
}

// 交易对精度配置
fn get_precision(symbol: &str) -> (u32, u32) {
    match symbol {
        "BTCUSDT" | "BTCUSDC" => (3, 1),
        "ETHUSDT" | "ETHUSDC" => (3, 2),
        "BNBUSDT" => (2, 2),
        "SOLUSDT" => (0, 2),
        _ => (3, 2),
    }
}

fn format_quantity(qty: f64, precision: u32) -> String {
    format!("{:.prec$}", qty, prec = precision as usize)
}

fn format_price(price: f64, precision: u32) -> String {
    format!("{:.prec$}", price, prec = precision as usize)
}

/// 获取账户余额
pub async fn get_balance(config: &BinanceConfig, asset: &str) -> anyhow::Result<f64> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let query = format!("timestamp={}", timestamp);
    let signature = generate_signature(&query, &config.api_secret);
    // 使用 /fapi/v2/account 端点，和前端一致
    let url = format!("{}/fapi/v2/account?{}&signature={}", config.base_url(), query, signature);

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    let data: serde_json::Value = resp.json().await?;

    if let Some(assets) = data.get("assets").and_then(|a| a.as_array()) {
        for asset_data in assets {
            if asset_data["asset"].as_str() == Some(asset) {
                let available = asset_data["availableBalance"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);
                return Ok(available);
            }
        }
    }

    Ok(0.0)
}

/// 取消所有挂单（普通订单 + Algo 条件单）
pub async fn cancel_all_orders(config: &BinanceConfig, symbol: &str) -> anyhow::Result<()> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let query = format!("symbol={}&timestamp={}", symbol, timestamp);
    let signature = generate_signature(&query, &config.api_secret);

    let client = reqwest::Client::new();

    // 1. 取消所有普通挂单
    let url = format!("{}/fapi/v1/allOpenOrders?{}&signature={}", config.base_url(), query, signature);
    let resp = client
        .delete(&url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    let _data: serde_json::Value = resp.json().await?;
    println!("[Binance] 已取消 {} 所有普通挂单", symbol);

    // 2. 取消所有 Algo 条件单（需要逐个取消）
    let algo_query = format!("symbol={}&timestamp={}", symbol, timestamp);
    let algo_signature = generate_signature(&algo_query, &config.api_secret);
    let algo_url = format!("{}/fapi/v1/openAlgoOrders?{}&signature={}", config.base_url(), algo_query, algo_signature);

    let algo_resp = client
        .get(&algo_url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    if let Ok(algo_data) = algo_resp.json::<Vec<serde_json::Value>>().await {
        for algo_order in algo_data.iter() {
            if let Some(algo_id) = algo_order.get("algoId").and_then(|v| v.as_u64()) {
                let cancel_query = format!("symbol={}&algoId={}&timestamp={}", symbol, algo_id, chrono::Utc::now().timestamp_millis());
                let cancel_sig = generate_signature(&cancel_query, &config.api_secret);
                let cancel_url = format!("{}/fapi/v1/algoOrder?{}&signature={}", config.base_url(), cancel_query, cancel_sig);

                let cancel_resp = client
                    .delete(&cancel_url)
                    .header("X-MBX-APIKEY", &config.api_key)
                    .send()
                    .await;

                if cancel_resp.is_ok() {
                    println!("[Binance] 已取消 Algo 单: algoId={}", algo_id);
                }
            }
        }
    }

    Ok(())
}

/// 下限价单
pub async fn place_limit_order(
    config: &BinanceConfig,
    symbol: &str,
    side: &str,           // BUY or SELL
    position_side: &str,  // LONG or SHORT
    price: f64,
    quantity: f64,
    client_order_id: &str,
) -> anyhow::Result<u64> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let (qty_precision, price_precision) = get_precision(symbol);
    let query = format!(
        "symbol={}&side={}&positionSide={}&type=LIMIT&quantity={}&price={}&timeInForce=GTC&timestamp={}&newClientOrderId={}",
        symbol, side, position_side,
        format_quantity(quantity, qty_precision),
        format_price(price, price_precision),
        timestamp,
        client_order_id
    );
    let signature = generate_signature(&query, &config.api_secret);
    let url = format!("{}/fapi/v1/order?{}&signature={}", config.base_url(), query, signature);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    let data: serde_json::Value = resp.json().await?;

    if let Some(order_id) = data.get("orderId").and_then(|v| v.as_u64()) {
        println!("[Binance] 下限价单成功: {} {} {} {}@{}", side, position_side, quantity, symbol, price);
        return Ok(order_id);
    }

    let msg = data.get("msg").and_then(|v| v.as_str()).unwrap_or("未知错误");
    anyhow::bail!("下限价单失败: {}", msg)
}

/// 下止损单 (STOP_MARKET)
pub async fn place_stop_loss_order(
    config: &BinanceConfig,
    symbol: &str,
    side: &str,           // 平仓方向 BUY(空头平) or SELL(多头平)
    position_side: &str,  // LONG or SHORT
    quantity: f64,
    stop_price: f64,
    client_order_id: &str,
) -> anyhow::Result<String> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let (qty_precision, price_precision) = get_precision(symbol);
    let query = format!(
        "symbol={}&side={}&positionSide={}&type=STOP_MARKET&quantity={}&triggerPrice={}&timestamp={}&newClientOrderId={}&algoType=CONDITIONAL",
        symbol, side, position_side,
        format_quantity(quantity, qty_precision),
        format_price(stop_price, price_precision),
        timestamp,
        client_order_id
    );
    let signature = generate_signature(&query, &config.api_secret);
    let url = format!("{}/fapi/v1/orderAlgo?{}&signature={}", config.base_url(), query, signature);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    let data: serde_json::Value = resp.json().await?;

    if let Some(algo_id) = data.get("algoId").and_then(|v| v.as_str()) {
        println!("[Binance] 止损单成功: {} {} {} {}@{}", position_side, side, quantity, symbol, stop_price);
        return Ok(algo_id.to_string());
    }

    let msg = data.get("msg").and_then(|v| v.as_str()).unwrap_or("未知错误");
    anyhow::bail!("止损单失败: {}", msg)
}

/// 下止盈单 (TAKE_PROFIT_MARKET)
pub async fn place_take_profit_order(
    config: &BinanceConfig,
    symbol: &str,
    side: &str,           // 平仓方向 BUY(空头平) or SELL(多头平)
    position_side: &str,  // LONG or SHORT
    quantity: f64,
    take_profit_price: f64,
    client_order_id: &str,
) -> anyhow::Result<String> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let (qty_precision, price_precision) = get_precision(symbol);
    let query = format!(
        "symbol={}&side={}&positionSide={}&type=TAKE_PROFIT_MARKET&quantity={}&triggerPrice={}&timestamp={}&newClientOrderId={}&algoType=CONDITIONAL",
        symbol, side, position_side,
        format_quantity(quantity, qty_precision),
        format_price(take_profit_price, price_precision),
        timestamp,
        client_order_id
    );
    let signature = generate_signature(&query, &config.api_secret);
    let url = format!("{}/fapi/v1/orderAlgo?{}&signature={}", config.base_url(), query, signature);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    let data: serde_json::Value = resp.json().await?;

    if let Some(algo_id) = data.get("algoId").and_then(|v| v.as_str()) {
        println!("[Binance] 止盈单成功: {} {} {} {}@{}", position_side, side, quantity, symbol, take_profit_price);
        return Ok(algo_id.to_string());
    }

    let msg = data.get("msg").and_then(|v| v.as_str()).unwrap_or("未知错误");
    anyhow::bail!("止盈单失败: {}", msg)
}

/// 获取 Algo 条件单（止损/止盈/追踪止盈）
pub async fn get_algo_orders(config: &BinanceConfig, symbol: &str) -> anyhow::Result<Vec<OpenOrderInfo>> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let query = format!("symbol={}&timestamp={}", symbol, timestamp);
    let signature = generate_signature(&query, &config.api_secret);
    let url = format!("{}/fapi/v1/openAlgoOrders?{}&signature={}", config.base_url(), query, signature);

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    // Algo API 可能返回空数组或错误，不抛出异常
    let data: Vec<serde_json::Value> = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(vec![]),
    };

    let orders = data
        .iter()
        .map(|order| {
            let trigger_price = order.get("triggerPrice")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
            let price = order.get("price")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
            let algo_id = order.get("algoId")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let client_algo_id = order.get("clientAlgoId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let side = order.get("side")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let position_side = order.get("positionSide")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let quantity = order.get("quantity")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string();
            let order_type = order.get("orderType")
                .and_then(|v| v.as_str())
                .unwrap_or("STOP_MARKET")
                .to_string();

            // 用于显示的 price 字段用 triggerPrice
            OpenOrderInfo {
                order_id: algo_id,
                symbol: symbol.to_string(),
                client_order_id: client_algo_id,
                side,
                position_side,
                orig_qty: quantity,
                price: if trigger_price > 0.0 { trigger_price.to_string() } else { price.to_string() },
                order_type,
                status: order.get("algoStatus").and_then(|v| v.as_str()).unwrap_or("new").to_string(),
            }
        })
        .collect();

    Ok(orders)
}

/// 获取当前挂单（普通订单 + Algo 条件单）
pub async fn get_all_open_orders(config: &BinanceConfig, symbol: &str) -> anyhow::Result<Vec<OpenOrderInfo>> {
    let (normal, algo) = tokio::join!(
        get_open_orders(config, symbol),
        get_algo_orders(config, symbol)
    );

    let mut orders = normal?;
    orders.extend(algo?);
    Ok(orders)
}

/// 获取当前挂单
pub async fn get_open_orders(config: &BinanceConfig, symbol: &str) -> anyhow::Result<Vec<OpenOrderInfo>> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let query = format!("symbol={}&timestamp={}", symbol, timestamp);
    let signature = generate_signature(&query, &config.api_secret);
    let url = format!("{}/fapi/v1/openOrders?{}&signature={}", config.base_url(), query, signature);

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    let data: Vec<serde_json::Value> = resp.json().await?;

    let orders = data
        .iter()
        .map(|order| OpenOrderInfo {
            order_id: order.get("orderId").and_then(|v| v.as_u64()).unwrap_or(0),
            symbol: order.get("symbol").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            client_order_id: order.get("clientOrderId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            side: order.get("side").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            position_side: order.get("positionSide").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            orig_qty: order.get("origQty").and_then(|v| v.as_str()).unwrap_or("0").to_string(),
            price: order.get("price").and_then(|v| v.as_str()).unwrap_or("0").to_string(),
            order_type: order.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            status: order.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        })
        .collect();

    Ok(orders)
}

/// 仓位信息
#[derive(Debug)]
pub struct PositionInfo {
    pub symbol: String,
    pub position_side: String,
    pub position_amt: f64,
    pub entry_price: f64,
    pub mark_price: f64,
    pub un_realized_profit: f64,
}

/// 获取当前持仓
pub async fn get_positions(config: &BinanceConfig, symbol: &str) -> anyhow::Result<Vec<PositionInfo>> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let query = format!("symbol={}&timestamp={}", symbol, timestamp);
    let signature = generate_signature(&query, &config.api_secret);
    let url = format!("{}/fapi/v2/positionRisk?{}&signature={}", config.base_url(), query, signature);

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    let data: Vec<serde_json::Value> = resp.json().await?;

    let positions = data
        .into_iter()
        .filter(|p| {
            let amt = p.get("positionAmt").and_then(|v| v.as_str()).unwrap_or("0");
            amt.parse::<f64>().unwrap_or(0.0).abs() > 0.001
        })
        .map(|p| PositionInfo {
            symbol: p.get("symbol").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            position_side: p.get("positionSide").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            position_amt: p.get("positionAmt").and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            entry_price: p.get("entryPrice").and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            mark_price: p.get("markPrice").and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            un_realized_profit: p.get("unRealizedProfit").and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
        })
        .collect();

    Ok(positions)
}

/// 下追踪止盈单 (TRAILING_STOP_MARKET)
/// activationPrice: 激活价格（盈利至此价格后开始追踪）
/// callbackRate: 回撤比例 0.1-10 (代表 0.1%-10%)
/// 盈利300点后回调100点，即 callbackRate = 100/价格 ≈ 0.125% 约等于 0.13
pub async fn place_trailing_stop_order(
    config: &BinanceConfig,
    symbol: &str,
    side: &str,           // 平仓方向 BUY(空头平) or SELL(多头平)
    position_side: &str,  // LONG or SHORT
    quantity: f64,
    callback_rate: f64,   // 回撤比例 0.1-10
    activation_price: f64,
    client_order_id: &str,
) -> anyhow::Result<String> {
    let timestamp = chrono::Utc::now().timestamp_millis();
    let (qty_precision, price_precision) = get_precision(symbol);
    let query = format!(
        "symbol={}&side={}&positionSide={}&type=TRAILING_STOP_MARKET&quantity={}&callbackRate={}&triggerPrice={}&timestamp={}&newClientOrderId={}&algoType=CONDITIONAL",
        symbol, side, position_side,
        format_quantity(quantity, qty_precision),
        callback_rate,
        format_price(activation_price, price_precision),
        timestamp,
        client_order_id
    );
    let signature = generate_signature(&query, &config.api_secret);
    let url = format!("{}/fapi/v1/orderAlgo?{}&signature={}", config.base_url(), query, signature);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("X-MBX-APIKEY", &config.api_key)
        .send()
        .await?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    // 打印响应状态和内容用于调试
    println!("[Binance] 追踪止盈响应: status={}, body={}", status, body);

    // 尝试解析 JSON
    let data: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            println!("[Binance] JSON 解析失败: {} body={}", e, body);
            anyhow::bail!("追踪止盈响应解析失败: {} body={}", e, body);
        }
    };

    if let Some(algo_id) = data.get("algoId").and_then(|v| v.as_str()) {
        println!("[Binance] 追踪止盈成功: {} {} {} 激活=${:.2} 回撤={}%",
            position_side, side, quantity, activation_price, callback_rate);
        return Ok(algo_id.to_string());
    }

    let msg = data.get("msg").and_then(|v| v.as_str()).unwrap_or("未知错误");
    anyhow::bail!("追踪止盈失败: {}", msg)
}