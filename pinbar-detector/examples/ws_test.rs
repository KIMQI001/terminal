//! Binance WebSocket 消息解析测试

use serde::Deserialize;

// 直接 K线消息格式（无 stream 包装）
#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct DirectKlineMessage {
    e: String,
    E: i64,
    s: String,
    k: Option<BinanceKline>,
}

// Binance K线数据
#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct BinanceKline {
    t: i64,
    T: i64,
    s: String,
    i: String,
    o: String,
    c: String,
    h: String,
    l: String,
    v: String,
    x: bool,
    q: String,
    n: i64,
}

fn main() {
    // 测试直接格式消息（来自用户日志）
    let direct_json = r#"{"e":"kline","E":1778542350213,"s":"BTCUSDT","k":{"t":1778542200000,"T":1778543099999,"s":"BTCUSDT","i":"15m","f":7649971738,"L":7649974897,"o":"81587.00","c":"81650.10","h":"81665.50","l":"81580.00","v":"0.783","n":527,"x":false,"q":"63941.64360","V":"0.487","Q":"39764.53810","B":"0"}}"#;

    println!("=== 测试直接格式解析 (USDT 合约) ===");
    match serde_json::from_str::<DirectKlineMessage>(direct_json) {
        Ok(msg) => {
            println!("解析成功!");
            println!("e = {}", msg.e);
            println!("E = {}", msg.E);
            println!("s = {}", msg.s);
            if let Some(k) = msg.k {
                println!("k.t = {}", k.t);
                println!("k.T = {}", k.T);
                println!("k.o = {}", k.o);
                println!("k.c = {}", k.c);
                println!("k.x = {}", k.x);
            }
        }
        Err(e) => {
            println!("解析失败: {}", e);
        }
    }

    println!("\n=== USDC 合约测试 ===");
    println!("USDC 合约 WebSocket: wss://dapi.binance.com/ws/btcusdc@kline_15m");
    println!("USDC 合约 REST API: https://dapi.binance.com");
}