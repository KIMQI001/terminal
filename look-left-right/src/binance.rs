//! Binance USDⓈ-M Futures REST 客户端
//!
//! 覆盖 look-left-right 策略层需要的全部 REST 能力:
//! - 行情/账户:现价、USDT 余额、杠杆、双向持仓(hedge)模式、持仓、挂单、Algo 挂单
//! - 下单:限价入场单(LIMIT)、条件单(STOP_MARKET / TAKE_PROFIT_MARKET,走 Algo API)
//! - 撤单:普通单、Algo 单、按 clientOrderId 前缀批量撤
//!
//! 设计要点:
//! - **签名**:HMAC-SHA256(hex) over「按 key 字典序拼接的 query string」,请求头 `X-MBX-APIKEY`
//! - **精度**:优先查 `GET /fapi/v1/exchangeInfo` 的 tickSize / stepSize 换算小数位
//!   (每个 symbol 只查一次,进程内缓存),查不到用静态兜底表
//! - **错误**:Binance 4xx/5xx 时解析 body 里的 `{"code":..,"msg":..}`,写进 `OrderResult.error`,
//!   `success=false`,不 panic
//! - **条件单**:2025-12-09 起 `STOP_MARKET` / `TAKE_PROFIT_MARKET` 必须走 Algo API
//!   (`POST /fapi/v1/algoOrder`,字段 `algoType=CONDITIONAL` + `triggerPrice` + `clientAlgoId`)

use anyhow::{anyhow, Context, Result};
use hmac::{Hmac, Mac};
use reqwest::{Client, Method};
use serde_json::Value;
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};
use urlencoding::encode as url_encode;

type HmacSha256 = Hmac<Sha256>;

/// 生产环境 base url
const PROD_BASE_URL: &str = "https://fapi.binance.com";
/// 测试网 base url
const TESTNET_BASE_URL: &str = "https://testnet.binancefuture.com";
/// 单次请求超时(秒)
const REQUEST_TIMEOUT_SEC: u64 = 15;

/// 静态兜底精度表:(symbol, qty 小数位, price 小数位)
///
/// 交易所 `exchangeInfo` 拿不到时用(对齐 wick-sr-detector/src/order.rs 的 get_precision)
const FALLBACK_PRECISION: &[(&str, u32, u32)] = &[
    ("BTCUSDC", 3, 1),
    ("BTCUSDT", 3, 1),
    ("ETHUSDC", 3, 2),
    ("ETHUSDT", 3, 2),
];

/// 兜底精度(未命中静态表时)
const DEFAULT_PRECISION: (u32, u32) = (3, 2);

/// 精度缓存(symbol → (qty 小数位, price 小数位))
static PRECISION_CACHE: OnceLock<Mutex<HashMap<String, (u32, u32)>>> = OnceLock::new();

/// 全局共享的 HTTP client(带 15s 超时)
static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        match Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SEC))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                error!("[Binance] 构建 HTTP client 失败({}),退回默认 client", e);
                Client::new()
            }
        }
    })
}

fn precision_cache() -> &'static Mutex<HashMap<String, (u32, u32)>> {
    PRECISION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 当前时间(unix 毫秒)
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// HMAC-SHA256 签名(hex 编码,64 字符)
///
/// Binance 要求 hex(不是 base64),签名对象是「按 key 字典序拼接的 query string」本身。
fn sign_query(query: &str, secret: &str) -> String {
    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(e) => {
            error!("[Binance] HMAC 初始化失败: {}", e);
            return String::new();
        }
    };
    mac.update(query.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// 拼 query string:按 key 字典序排序,value 做 URL 编码
///
/// 签名和发送用的是同一个字符串,保证 Binance 侧校验通过。
fn build_query(params: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted
        .iter()
        .map(|(k, v)| format!("{}={}", k, url_encode(v)))
        .collect::<Vec<String>>()
        .join("&")
}

/// 从 stepSize / tickSize 字符串换算小数位
///
/// "0.001" → 3,"0.01000" → 3,"1" → 0,"1.0" → 0
fn decimals_from_step(step: &str) -> u32 {
    let s = step.trim();
    match s.find('.') {
        Some(idx) => {
            let frac = &s[idx + 1..];
            frac.trim_end_matches('0').len() as u32
        }
        None => 0,
    }
}

/// 去掉小数末尾多余的 0("74701.5000" → "74701.5","1.000" → "1")
fn trim_trailing_zeros(s: &str) -> String {
    if !s.contains('.') {
        return s.to_string();
    }
    let t = s.trim_end_matches('0');
    let t = t.trim_end_matches('.');
    if t.is_empty() || t == "-" {
        "0".to_string()
    } else {
        t.to_string()
    }
}

/// 按小数位格式化数量/价格,并去掉多余的 0
fn format_decimal(value: f64, decimals: u32) -> String {
    trim_trailing_zeros(&format!("{:.*}", decimals as usize, value))
}

/// JSON 值 → f64(Binance 数值字段大多是字符串)
fn json_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// 从 Binance 响应里提取错误信息
///
/// 4xx/5xx 时优先用 body 里的 `msg`,其次 `HTTP {status}`。
fn extract_error(status: u16, value: &Value) -> Option<String> {
    if (200..300).contains(&status) {
        return None;
    }
    let code = value.get("code").and_then(|c| c.as_i64());
    let msg = value.get("msg").and_then(|m| m.as_str()).unwrap_or("");
    if msg.is_empty() {
        Some(format!("HTTP {}", status))
    } else {
        match code {
            Some(c) => Some(format!("code={} msg={}", c, msg)),
            None => Some(format!("HTTP {} msg={}", status, msg)),
        }
    }
}

// ============== 公开数据结构 ==============

/// 下单结果
///
/// 普通单看 `order_id`,Algo 单看 `algo_id`。
/// `success == false` 时 `error` 一定有值(网络失败 / 数量为 0 / Binance 报错)。
#[derive(Debug, Clone, Default)]
pub struct OrderResult {
    pub success: bool,
    /// 普通单 orderId
    pub order_id: Option<u64>,
    /// Algo 单 algoId
    pub algo_id: Option<u64>,
    pub client_order_id: Option<String>,
    pub error: Option<String>,
}

/// 持仓信息
#[derive(Debug, Clone)]
pub struct Position {
    /// "LONG" / "SHORT" / "BOTH"(one-way 模式)
    pub position_side: String,
    pub position_amt: f64,
    pub entry_price: f64,
    pub leverage: f64,
}

/// 挂单(普通单)
#[derive(Debug, Clone)]
pub struct OpenOrder {
    pub order_id: u64,
    pub client_order_id: String,
    /// "BUY" / "SELL"
    pub side: String,
    pub position_side: String,
    pub price: f64,
    pub orig_qty: f64,
    /// "LIMIT" / "STOP_MARKET" ...
    pub order_type: String,
    pub reduce_only: bool,
}

/// 挂单(Algo 条件单)
#[derive(Debug, Clone)]
pub struct AlgoOrder {
    pub algo_id: u64,
    pub client_algo_id: String,
    pub side: String,
    pub position_side: String,
    pub order_type: String,
    pub trigger_price: f64,
    pub quantity: f64,
    pub reduce_only: bool,
}

// ============== Binance 客户端 ==============

/// Binance USDⓈ-M Futures REST 客户端
#[derive(Debug, Clone)]
pub struct BinanceApi {
    pub api_key: String,
    pub api_secret: String,
    /// `https://fapi.binance.com` 或 testnet
    pub base_url: String,
}

impl BinanceApi {
    /// 新建客户端
    ///
    /// `is_testnet = true` → `https://testnet.binancefuture.com`,否则 `https://fapi.binance.com`
    pub fn new(api_key: &str, api_secret: &str, is_testnet: bool) -> Self {
        let base_url = if is_testnet {
            TESTNET_BASE_URL
        } else {
            PROD_BASE_URL
        };
        info!(
            "[Binance] 初始化 API client: base_url={} api_key={}",
            base_url,
            if api_key.is_empty() {
                "(未配置)"
            } else {
                "已配置"
            }
        );
        Self {
            api_key: api_key.to_string(),
            api_secret: api_secret.to_string(),
            base_url: base_url.to_string(),
        }
    }

    // ============ 内部请求 ============

    /// 统一请求入口:返回 (HTTP status, 解析后的 JSON body)
    ///
    /// `signed = true` 时自动追加 timestamp 并计算 signature。
    async fn request(
        &self,
        method: Method,
        path: &str,
        params: &[(String, String)],
        signed: bool,
    ) -> Result<(u16, Value)> {
        let mut all: Vec<(String, String)> = params.to_vec();
        if signed {
            if self.api_key.is_empty() || self.api_secret.is_empty() {
                return Err(anyhow!("[Binance] API key/secret 未配置,无法请求 {}", path));
            }
            all.push(("timestamp".to_string(), now_millis().to_string()));
        }
        let query = build_query(&all);
        let mut url = format!("{}{}?{}", self.base_url, path, query);
        if signed {
            let sig = sign_query(&query, &self.api_secret);
            url.push_str(&format!("&signature={}", sig));
        }
        let method_str = method.to_string();
        debug!("[Binance] {} {}", method_str, path);

        let mut req = http_client().request(method, &url);
        if !self.api_key.is_empty() {
            req = req.header("X-MBX-APIKEY", &self.api_key);
        }
        let resp = req
            .send()
            .await
            .with_context(|| format!("[Binance] 请求失败 {} {}", method_str, path))?;
        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .with_context(|| format!("[Binance] 读取响应体失败 {}", path))?;
        let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            warn!(
                "[Binance] {} {} HTTP {} body={}",
                method_str, path, status, body
            );
        }
        Ok((status, value))
    }

    // ============ 行情 / 账户 ============

    /// 当前价(`GET /fapi/v1/ticker/price`)
    pub async fn get_price(&self, symbol: &str) -> Result<f64> {
        let params = vec![("symbol".to_string(), symbol.to_string())];
        let (status, value) = self
            .request(Method::GET, "/fapi/v1/ticker/price", &params, false)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            return Err(anyhow!("[Binance] get_price {} 失败: {}", symbol, err));
        }
        value
            .get("price")
            .and_then(json_f64)
            .ok_or_else(|| anyhow!("[Binance] get_price {} 响应无 price 字段", symbol))
    }

    /// USDT 可用余额(`GET /fapi/v2/account`)
    ///
    /// 优先取 `assets[]` 里 USDT 的 `availableBalance`;取不到则退回顶层的
    /// `availableBalance`,再退到 `totalWalletBalance`。
    pub async fn get_balance(&self) -> Result<f64> {
        let (status, value) = self
            .request(Method::GET, "/fapi/v2/account", &[], true)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            return Err(anyhow!("[Binance] get_balance 失败: {}", err));
        }
        // assets[] 里的 USDT
        if let Some(assets) = value.get("assets").and_then(|a| a.as_array()) {
            for a in assets {
                if a.get("asset").and_then(|x| x.as_str()) == Some("USDT") {
                    if let Some(bal) = a.get("availableBalance").and_then(json_f64) {
                        return Ok(bal);
                    }
                }
            }
        }
        // 顶层 availableBalance / totalWalletBalance
        if let Some(bal) = value.get("availableBalance").and_then(json_f64) {
            return Ok(bal);
        }
        if let Some(bal) = value.get("totalWalletBalance").and_then(json_f64) {
            return Ok(bal);
        }
        Err(anyhow!("[Binance] get_balance 响应里找不到 USDT 余额字段"))
    }

    /// 交易对杠杆(`GET /fapi/v1/leverage`)
    ///
    /// 该接口在用户从没调过 `POST /fapi/v1/leverage` 时会报 -4028,
    /// 此时自动回退到 `GET /fapi/v2/positionRisk` 的 `leverage` 字段。
    pub async fn get_leverage(&self, symbol: &str) -> Result<u32> {
        let params = vec![("symbol".to_string(), symbol.to_string())];
        let (status, value) = self
            .request(Method::GET, "/fapi/v1/leverage", &params, true)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            warn!(
                "[Binance] get_leverage {} 失败({}),回退 positionRisk",
                symbol, err
            );
            return self.leverage_from_position_risk(symbol).await;
        }
        match value.get("leverage").and_then(json_f64) {
            Some(lev) => Ok(lev as u32),
            None => {
                warn!("[Binance] get_leverage {} 响应无 leverage 字段", symbol);
                self.leverage_from_position_risk(symbol).await
            }
        }
    }

    /// 从 positionRisk 里取 symbol 的 leverage
    async fn leverage_from_position_risk(&self, symbol: &str) -> Result<u32> {
        let params = vec![("symbol".to_string(), symbol.to_string())];
        let (status, value) = self
            .request(Method::GET, "/fapi/v2/positionRisk", &params, true)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            return Err(anyhow!("[Binance] get_leverage {} 失败: {}", symbol, err));
        }
        if let Some(arr) = value.as_array() {
            for p in arr {
                if p.get("symbol").and_then(|v| v.as_str()) == Some(symbol) {
                    if let Some(lev) = p.get("leverage").and_then(json_f64) {
                        return Ok(lev as u32);
                    }
                }
            }
        }
        Err(anyhow!("[Binance] get_leverage {} 找不到 leverage", symbol))
    }

    /// 是否双向持仓(hedge)模式(`GET /fapi/v1/positionSide/dual`)
    pub async fn is_hedge_mode(&self) -> Result<bool> {
        let (status, value) = self
            .request(Method::GET, "/fapi/v1/positionSide/dual", &[], true)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            return Err(anyhow!("[Binance] is_hedge_mode 失败: {}", err));
        }
        match value.get("dualSidePosition") {
            Some(Value::Bool(b)) => Ok(*b),
            Some(Value::String(s)) => Ok(s.eq_ignore_ascii_case("true")),
            _ => Err(anyhow!(
                "[Binance] is_hedge_mode 响应无 dualSidePosition 字段"
            )),
        }
    }

    /// 当前持仓(`GET /fapi/v2/positionRisk`)
    ///
    /// 只返回 `positionAmt != 0` 的条目(零仓位没有意义)。
    /// hedge 模式下会返回 LONG / SHORT 两个方向各自的持仓。
    pub async fn get_positions(&self, symbol: &str) -> Result<Vec<Position>> {
        let params = vec![("symbol".to_string(), symbol.to_string())];
        let (status, value) = self
            .request(Method::GET, "/fapi/v2/positionRisk", &params, true)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            return Err(anyhow!("[Binance] get_positions {} 失败: {}", symbol, err));
        }
        let mut positions = Vec::new();
        if let Some(arr) = value.as_array() {
            for p in arr {
                if p.get("symbol").and_then(|v| v.as_str()) != Some(symbol) {
                    continue;
                }
                let amt = p.get("positionAmt").and_then(json_f64).unwrap_or(0.0);
                if amt.abs() < f64::EPSILON {
                    continue;
                }
                positions.push(Position {
                    position_side: p
                        .get("positionSide")
                        .and_then(|v| v.as_str())
                        .unwrap_or("BOTH")
                        .to_string(),
                    position_amt: amt,
                    entry_price: p.get("entryPrice").and_then(json_f64).unwrap_or(0.0),
                    leverage: p.get("leverage").and_then(json_f64).unwrap_or(0.0),
                });
            }
        }
        Ok(positions)
    }

    /// 当前挂单(`GET /fapi/v1/openOrders`)
    pub async fn get_open_orders(&self, symbol: &str) -> Result<Vec<OpenOrder>> {
        let params = vec![("symbol".to_string(), symbol.to_string())];
        let (status, value) = self
            .request(Method::GET, "/fapi/v1/openOrders", &params, true)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            return Err(anyhow!(
                "[Binance] get_open_orders {} 失败: {}",
                symbol,
                err
            ));
        }
        let mut orders = Vec::new();
        if let Some(arr) = value.as_array() {
            for o in arr {
                let order_id = o.get("orderId").and_then(json_f64).unwrap_or(0.0) as u64;
                if order_id == 0 {
                    continue;
                }
                orders.push(OpenOrder {
                    order_id,
                    client_order_id: o
                        .get("clientOrderId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    side: o
                        .get("side")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    position_side: o
                        .get("positionSide")
                        .and_then(|v| v.as_str())
                        .unwrap_or("BOTH")
                        .to_string(),
                    price: o.get("price").and_then(json_f64).unwrap_or(0.0),
                    orig_qty: o.get("origQty").and_then(json_f64).unwrap_or(0.0),
                    order_type: o
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    reduce_only: o
                        .get("reduceOnly")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                });
            }
        }
        Ok(orders)
    }

    /// 当前 Algo 条件挂单(`GET /fapi/v1/openAlgoOrders`)
    pub async fn get_open_algo_orders(&self, symbol: &str) -> Result<Vec<AlgoOrder>> {
        let params = vec![("symbol".to_string(), symbol.to_string())];
        let (status, value) = self
            .request(Method::GET, "/fapi/v1/openAlgoOrders", &params, true)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            return Err(anyhow!(
                "[Binance] get_open_algo_orders {} 失败: {}",
                symbol,
                err
            ));
        }
        let mut algos = Vec::new();
        if let Some(arr) = value.as_array() {
            for a in arr {
                let algo_id = a.get("algoId").and_then(json_f64).unwrap_or(0.0) as u64;
                if algo_id == 0 {
                    continue;
                }
                // triggerPrice 是官方字段名;个别版本用 stopPrice,两个都兜一下
                let trigger_price = a
                    .get("triggerPrice")
                    .and_then(json_f64)
                    .or_else(|| a.get("stopPrice").and_then(json_f64))
                    .unwrap_or(0.0);
                let quantity = a
                    .get("quantity")
                    .and_then(json_f64)
                    .or_else(|| a.get("origQty").and_then(json_f64))
                    .unwrap_or(0.0);
                algos.push(AlgoOrder {
                    algo_id,
                    client_algo_id: a
                        .get("clientAlgoId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    side: a
                        .get("side")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    position_side: a
                        .get("positionSide")
                        .and_then(|v| v.as_str())
                        .unwrap_or("BOTH")
                        .to_string(),
                    order_type: a
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    trigger_price,
                    quantity,
                    reduce_only: a
                        .get("reduceOnly")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                });
            }
        }
        Ok(algos)
    }

    // ============ 精度 ============

    /// 取 symbol 的精度:(qty 小数位, price 小数位)
    ///
    /// 优先查 `GET /fapi/v1/exchangeInfo` 的 PRICE_FILTER.tickSize / LOT_SIZE.stepSize,
    /// 每个 symbol 只查一次(进程内缓存);查不到用静态兜底表。
    pub async fn get_precision(&self, symbol: &str) -> (u32, u32) {
        let mut cache = precision_cache().lock().await;
        if let Some(p) = cache.get(symbol) {
            return *p;
        }
        match self.fetch_exchange_info().await {
            Ok(map) => {
                for (s, p) in map.iter() {
                    cache.insert(s.clone(), *p);
                }
                info!("[Binance] exchangeInfo 载入 {} 个 symbol 的精度", map.len());
            }
            Err(e) => {
                warn!("[Binance] 拉 exchangeInfo 失败({}),使用兜底精度", e);
            }
        }
        if let Some(p) = cache.get(symbol) {
            return *p;
        }
        // 兜底:静态表 → 默认值,并写入缓存避免反复请求
        let fallback = fallback_precision(symbol);
        cache.insert(symbol.to_string(), fallback);
        fallback
    }

    /// 拉 exchangeInfo,返回 symbol → (qty 小数位, price 小数位)
    async fn fetch_exchange_info(&self) -> Result<HashMap<String, (u32, u32)>> {
        let (status, value) = self
            .request(Method::GET, "/fapi/v1/exchangeInfo", &[], false)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            return Err(anyhow!("[Binance] exchangeInfo 失败: {}", err));
        }
        let mut map: HashMap<String, (u32, u32)> = HashMap::new();
        let symbols = value
            .get("symbols")
            .and_then(|s| s.as_array())
            .ok_or_else(|| anyhow!("[Binance] exchangeInfo 响应无 symbols 数组"))?;
        for s in symbols {
            let symbol = match s.get("symbol").and_then(|v| v.as_str()) {
                Some(v) => v.to_string(),
                None => continue,
            };
            let filters = match s.get("filters").and_then(|f| f.as_array()) {
                Some(f) => f,
                None => continue,
            };
            let mut price_decimals: Option<u32> = None;
            let mut qty_decimals: Option<u32> = None;
            for f in filters {
                let ftype = f.get("filterType").and_then(|v| v.as_str()).unwrap_or("");
                match ftype {
                    "PRICE_FILTER" => {
                        if let Some(ts) = f.get("tickSize").and_then(|v| v.as_str()) {
                            price_decimals = Some(decimals_from_step(ts));
                        }
                    }
                    // 现货/合约里 filterType 叫 LOT_SIZE,部分接口叫 QTY_FILTER,两个都认
                    "LOT_SIZE" | "QTY_FILTER" | "MARKET_LOT_SIZE" => {
                        if ftype == "MARKET_LOT_SIZE" {
                            continue;
                        }
                        if let Some(ss) = f.get("stepSize").and_then(|v| v.as_str()) {
                            qty_decimals = Some(decimals_from_step(ss));
                        }
                    }
                    _ => {}
                }
            }
            let qty = qty_decimals.unwrap_or(DEFAULT_PRECISION.0);
            let price = price_decimals.unwrap_or(DEFAULT_PRECISION.1);
            map.insert(symbol, (qty, price));
        }
        Ok(map)
    }

    // ============ 下单 ============

    /// 限价入场单(`POST /fapi/v1/order`,type=LIMIT,timeInForce=GTC)
    ///
    /// - `position_side`: hedge 模式传 "LONG"/"SHORT",one-way 模式传 "BOTH"
    /// - `reduce_only`: 只在 one-way 模式生效;hedge 模式下 Binance 不接受该参数,自动忽略
    /// - 数量格式化后为 0 时不下单,返回 `success=false`
    #[allow(clippy::too_many_arguments)]
    pub async fn place_limit_order(
        &self,
        symbol: &str,
        side: &str,
        position_side: &str,
        quantity: f64,
        price: f64,
        client_order_id: &str,
        reduce_only: bool,
    ) -> Result<OrderResult> {
        let (qty_p, price_p) = self.get_precision(symbol).await;
        let qty_str = format_decimal(quantity, qty_p);
        let price_str = format_decimal(price, price_p);
        if qty_str.parse::<f64>().unwrap_or(0.0) <= 0.0 {
            let err = format!(
                "数量格式化后为 0(qty={}, step 小数位={}),拒绝下单",
                quantity, qty_p
            );
            error!("[Binance] {} {}", symbol, err);
            return Ok(OrderResult {
                success: false,
                error: Some(err),
                ..Default::default()
            });
        }
        if price_str.parse::<f64>().unwrap_or(0.0) <= 0.0 {
            let err = format!(
                "价格格式化后为 0(price={}, tick 小数位={}),拒绝下单",
                price, price_p
            );
            error!("[Binance] {} {}", symbol, err);
            return Ok(OrderResult {
                success: false,
                error: Some(err),
                ..Default::default()
            });
        }

        let mut params: Vec<(String, String)> = vec![
            ("symbol".into(), symbol.to_string()),
            ("side".into(), side.to_string()),
            ("positionSide".into(), position_side.to_string()),
            ("type".into(), "LIMIT".into()),
            ("timeInForce".into(), "GTC".into()),
            ("quantity".into(), qty_str.clone()),
            ("price".into(), price_str.clone()),
        ];
        if !client_order_id.is_empty() {
            params.push(("newClientOrderId".into(), client_order_id.to_string()));
        }
        // hedge 模式下 Binance 拒绝 reduceOnly 参数(-1106),只在 one-way 模式带
        if reduce_only && position_side != "LONG" && position_side != "SHORT" {
            params.push(("reduceOnly".into(), "true".into()));
        }

        let (status, value) = self
            .request(Method::POST, "/fapi/v1/order", &params, true)
            .await?;
        let order_id = value.get("orderId").and_then(json_f64).unwrap_or(0.0) as u64;
        let resp_client_id = value
            .get("clientOrderId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if let Some(err) = extract_error(status, &value) {
            error!("[Binance] 限价单失败 {} {}: {}", symbol, side, err);
            return Ok(OrderResult {
                success: false,
                order_id: if order_id > 0 { Some(order_id) } else { None },
                algo_id: None,
                client_order_id: if resp_client_id.is_empty() {
                    None
                } else {
                    Some(resp_client_id)
                },
                error: Some(err),
            });
        }
        if order_id == 0 {
            let err = "限价单响应无 orderId".to_string();
            error!("[Binance] {} {}", symbol, err);
            return Ok(OrderResult {
                success: false,
                error: Some(err),
                ..Default::default()
            });
        }
        info!(
            "[Binance] 限价单 OK {} {} qty={} price={} orderId={}",
            symbol, side, qty_str, price_str, order_id
        );
        Ok(OrderResult {
            success: true,
            order_id: Some(order_id),
            algo_id: None,
            client_order_id: if resp_client_id.is_empty() {
                None
            } else {
                Some(resp_client_id)
            },
            error: None,
        })
    }

    /// 条件单(`POST /fapi/v1/algoOrder`,algoType=CONDITIONAL)
    ///
    /// `order_type` 取 "STOP_MARKET" / "TAKE_PROFIT_MARKET";触发价字段是 `triggerPrice`,
    /// 自定义 ID 字段是 `clientAlgoId`。
    #[allow(clippy::too_many_arguments)]
    pub async fn place_algo_order(
        &self,
        symbol: &str,
        side: &str,
        position_side: &str,
        order_type: &str,
        trigger_price: f64,
        quantity: f64,
        client_order_id: &str,
        reduce_only: bool,
    ) -> Result<OrderResult> {
        let (qty_p, price_p) = self.get_precision(symbol).await;
        let qty_str = format_decimal(quantity, qty_p);
        let trigger_str = format_decimal(trigger_price, price_p);
        if qty_str.parse::<f64>().unwrap_or(0.0) <= 0.0 {
            let err = format!(
                "数量格式化后为 0(qty={}, step 小数位={}),拒绝下单",
                quantity, qty_p
            );
            error!("[Binance] {} {}", symbol, err);
            return Ok(OrderResult {
                success: false,
                error: Some(err),
                ..Default::default()
            });
        }
        if trigger_str.parse::<f64>().unwrap_or(0.0) <= 0.0 {
            let err = format!(
                "触发价格式化后为 0(trigger={}, tick 小数位={}),拒绝下单",
                trigger_price, price_p
            );
            error!("[Binance] {} {}", symbol, err);
            return Ok(OrderResult {
                success: false,
                error: Some(err),
                ..Default::default()
            });
        }

        let mut params: Vec<(String, String)> = vec![
            ("algoType".into(), "CONDITIONAL".into()),
            ("symbol".into(), symbol.to_string()),
            ("side".into(), side.to_string()),
            ("positionSide".into(), position_side.to_string()),
            ("type".into(), order_type.to_string()),
            ("quantity".into(), qty_str.clone()),
            ("triggerPrice".into(), trigger_str.clone()),
        ];
        if !client_order_id.is_empty() {
            params.push(("clientAlgoId".into(), client_order_id.to_string()));
        }
        // Algo API 在 one-way 模式支持 reduceOnly;hedge 模式下不传
        if reduce_only && position_side != "LONG" && position_side != "SHORT" {
            params.push(("reduceOnly".into(), "true".into()));
        }

        let (status, value) = self
            .request(Method::POST, "/fapi/v1/algoOrder", &params, true)
            .await?;
        let algo_id = value.get("algoId").and_then(json_f64).unwrap_or(0.0) as u64;
        let resp_client_id = value
            .get("clientAlgoId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if let Some(err) = extract_error(status, &value) {
            error!(
                "[Binance] 条件单失败 {} {} {}: {}",
                symbol, order_type, side, err
            );
            return Ok(OrderResult {
                success: false,
                order_id: None,
                algo_id: if algo_id > 0 { Some(algo_id) } else { None },
                client_order_id: if resp_client_id.is_empty() {
                    None
                } else {
                    Some(resp_client_id)
                },
                error: Some(err),
            });
        }
        if algo_id == 0 {
            let err = "条件单响应无 algoId".to_string();
            error!("[Binance] {} {}", symbol, err);
            return Ok(OrderResult {
                success: false,
                error: Some(err),
                ..Default::default()
            });
        }
        info!(
            "[Binance] 条件单 OK {} {} {} qty={} trigger={} algoId={}",
            symbol, order_type, side, qty_str, trigger_str, algo_id
        );
        Ok(OrderResult {
            success: true,
            order_id: None,
            algo_id: Some(algo_id),
            client_order_id: if resp_client_id.is_empty() {
                None
            } else {
                Some(resp_client_id)
            },
            error: None,
        })
    }

    // ============ 撤单 ============

    /// 撤普通单(`DELETE /fapi/v1/order`)
    pub async fn cancel_order(&self, symbol: &str, order_id: u64) -> Result<OrderResult> {
        let params = vec![
            ("symbol".to_string(), symbol.to_string()),
            ("orderId".to_string(), order_id.to_string()),
        ];
        let (status, value) = self
            .request(Method::DELETE, "/fapi/v1/order", &params, true)
            .await?;
        if let Some(err) = extract_error(status, &value) {
            warn!(
                "[Binance] 撤普通单失败 {} orderId={}: {}",
                symbol, order_id, err
            );
            return Ok(OrderResult {
                success: false,
                error: Some(err),
                ..Default::default()
            });
        }
        info!("[Binance] 撤普通单 OK {} orderId={}", symbol, order_id);
        Ok(OrderResult {
            success: true,
            order_id: Some(order_id),
            algo_id: None,
            client_order_id: value
                .get("clientOrderId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            error: None,
        })
    }

    /// 撤 Algo 条件单(`DELETE /fapi/v1/algoOrder`)
    pub async fn cancel_algo_order(&self, symbol: &str, algo_id: u64) -> Result<OrderResult> {
        let params = vec![
            ("symbol".to_string(), symbol.to_string()),
            ("algoId".to_string(), algo_id.to_string()),
        ];
        let (status, value) = self
            .request(Method::DELETE, "/fapi/v1/algoOrder", &params, true)
            .await?;
        // Algo 撤单成功可能返回 {"code":0,"msg":"success"},也可能返回订单对象
        let code = value.get("code").and_then(|c| c.as_i64());
        if let Some(err) = extract_error(status, &value) {
            warn!(
                "[Binance] 撤 Algo 单失败 {} algoId={}: {}",
                symbol, algo_id, err
            );
            return Ok(OrderResult {
                success: false,
                error: Some(err),
                ..Default::default()
            });
        }
        if let Some(c) = code {
            if c != 0 {
                let msg = value
                    .get("msg")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let err = format!("code={} msg={}", c, msg);
                warn!(
                    "[Binance] 撤 Algo 单失败 {} algoId={}: {}",
                    symbol, algo_id, err
                );
                return Ok(OrderResult {
                    success: false,
                    error: Some(err),
                    ..Default::default()
                });
            }
        }
        info!("[Binance] 撤 Algo 单 OK {} algoId={}", symbol, algo_id);
        Ok(OrderResult {
            success: true,
            order_id: None,
            algo_id: Some(algo_id),
            client_order_id: value
                .get("clientAlgoId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            error: None,
        })
    }

    /// 按 clientOrderId / clientAlgoId 前缀批量撤单
    ///
    /// 先撤普通单,再撤 Algo 单;返回成功撤掉的数量。
    /// 单个撤单失败只告警,不影响其它单。
    pub async fn cancel_orders_by_prefix(&self, symbol: &str, prefix: &str) -> Result<usize> {
        let mut cancelled = 0usize;

        let orders = self.get_open_orders(symbol).await?;
        for o in orders {
            if !o.client_order_id.starts_with(prefix) {
                continue;
            }
            match self.cancel_order(symbol, o.order_id).await {
                Ok(r) if r.success => {
                    cancelled += 1;
                    info!(
                        "[Binance] 批量撤单: 普通单 orderId={} clientOrderId={}",
                        o.order_id, o.client_order_id
                    );
                }
                Ok(r) => {
                    warn!(
                        "[Binance] 批量撤单: 普通单 orderId={} 失败: {}",
                        o.order_id,
                        r.error.unwrap_or_else(|| "unknown".to_string())
                    );
                }
                Err(e) => {
                    warn!(
                        "[Binance] 批量撤单: 普通单 orderId={} 异常: {}",
                        o.order_id, e
                    );
                }
            }
        }

        let algos = self.get_open_algo_orders(symbol).await?;
        for a in algos {
            if !a.client_algo_id.starts_with(prefix) {
                continue;
            }
            match self.cancel_algo_order(symbol, a.algo_id).await {
                Ok(r) if r.success => {
                    cancelled += 1;
                    info!(
                        "[Binance] 批量撤单: Algo 单 algoId={} clientAlgoId={}",
                        a.algo_id, a.client_algo_id
                    );
                }
                Ok(r) => {
                    warn!(
                        "[Binance] 批量撤单: Algo 单 algoId={} 失败: {}",
                        a.algo_id,
                        r.error.unwrap_or_else(|| "unknown".to_string())
                    );
                }
                Err(e) => {
                    warn!(
                        "[Binance] 批量撤单: Algo 单 algoId={} 异常: {}",
                        a.algo_id, e
                    );
                }
            }
        }

        info!(
            "[Binance] 批量撤单完成 {} prefix={} 撤掉 {} 个",
            symbol, prefix, cancelled
        );
        Ok(cancelled)
    }
}

/// 静态兜底精度
fn fallback_precision(symbol: &str) -> (u32, u32) {
    for (s, q, p) in FALLBACK_PRECISION {
        if *s == symbol {
            return (*q, *p);
        }
    }
    DEFAULT_PRECISION
}
