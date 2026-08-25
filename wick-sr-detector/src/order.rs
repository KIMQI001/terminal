//! Binance 下单模块(简化版 — 限价单 + 止损 + 止盈 Algo 单)

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

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
fn sign_query(query: &str, secret: &str) -> String {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(query.as_bytes());
    let result = mac.finalize();
    let b64 = base64::engine::general_purpose::STANDARD.encode(result.into_bytes());
    b64
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
    let ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();

    // 1) 下限价单(入场)
    let entry_qs = format!(
        "symbol={}&side={}&positionSide={}&type=LIMIT&timeInForce=GTC&\
         quantity={}&price={}&newClientOrderId={}_entry&timestamp={}",
        symbol, side, position_side, quantity, entry_price, client_order_id_prefix, ts
    );
    let entry_sig = sign_query(&entry_qs, api_secret);
    let entry_url = format!(
        "{}/fapi/v1/order?{}&signature={}",
        base_url, entry_qs, entry_sig
    );

    #[derive(Serialize, Deserialize)]
    struct BinanceResp {
        #[serde(default, rename = "orderId")]
        order_id: u64,
        #[serde(default)]
        code: i32,
        #[serde(default)]
        msg: String,
    }

    let entry_resp: BinanceResp = client
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

    // 2) 止损 Algo(STOP_MARKET)— 价到 stop_loss 触发市价
    let stop_side = if side == "BUY" { "SELL" } else { "BUY" };
    let sl_ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let sl_qs = format!(
        "algoType=CONDITIONAL&symbol={}&side={}&positionSide={}&type=STOP_MARKET&\
         quantity={}&price={}&newClientOrderId={}_sl&timestamp={}",
        symbol, stop_side, position_side, quantity, stop_loss, client_order_id_prefix, sl_ts
    );
    let sl_sig = sign_query(&sl_qs, api_secret);
    let sl_url = format!("{}/fapi/v1/algoOrder?{}&signature={}", base_url, sl_qs, sl_sig);
    let sl_resp: BinanceResp = client
        .post(&sl_url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
        .context("send stop loss")?
        .json()
        .await
        .context("parse stop loss")?;
    if sl_resp.code != 0 && sl_resp.order_id == 0 {
        warn!("[Order] stop loss failed: code={} msg={}", sl_resp.code, sl_resp.msg);
    } else {
        info!("[Order] stop loss OK algoId={}", sl_resp.order_id);
    }

    // 3) 止盈 Algo(TAKE_PROFIT_MARKET)
    let tp_ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let tp_qs = format!(
        "algoType=CONDITIONAL&symbol={}&side={}&positionSide={}&type=TAKE_PROFIT_MARKET&\
         quantity={}&price={}&newClientOrderId={}_tp&timestamp={}",
        symbol, stop_side, position_side, quantity, take_profit, client_order_id_prefix, tp_ts
    );
    let tp_sig = sign_query(&tp_qs, api_secret);
    let tp_url = format!("{}/fapi/v1/algoOrder?{}&signature={}", base_url, tp_qs, tp_sig);
    let tp_resp: BinanceResp = client
        .post(&tp_url)
        .header("X-MBX-APIKEY", api_key)
        .send()
        .await
        .context("send take profit")?
        .json()
        .await
        .context("parse take profit")?;
    if tp_resp.code != 0 && tp_resp.order_id == 0 {
        warn!("[Order] take profit failed: code={} msg={}", tp_resp.code, tp_resp.msg);
    } else {
        info!("[Order] take profit OK algoId={}", tp_resp.order_id);
    }

    Ok(OrderResult {
        order_id: entry_resp.order_id.to_string(),
        stop_algo_id: sl_resp.order_id.to_string(),
        tp_algo_id: tp_resp.order_id.to_string(),
        entry_price,
        quantity,
    })
}

/// 计算下单数量(基于账户余额 + 仓位百分比 + 杠杆)
/// 简化版:quantity = (balance * pct) / entry_price,未考虑杠杆 —
/// USDT 永续默认 20x,如需 1x 在币安手动设置
pub fn calculate_quantity(
    wallet_balance: f64,
    position_pct: f64,
    entry_price: f64,
) -> f64 {
    if wallet_balance <= 0.0 || entry_price <= 0.0 {
        return 0.0;
    }
    (wallet_balance * position_pct) / entry_price
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
