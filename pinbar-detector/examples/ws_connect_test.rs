//! Binance WebSocket 连接测试

use futures_util::{StreamExt};
use serde::Deserialize;
use tokio_tungstenite::{connect_async, tungstenite::Message};

// 直接 K线消息格式
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // USDC 合约 WebSocket 地址（与 kline-server 一致）
    let url = "wss://fstream.binance.com/market/ws/btcusdc@kline_15m";

    println!("Connecting to {}...", url);
    let (ws_stream, _) = connect_async(url).await?;
    println!("Connected!");

    let (_, mut read) = ws_stream.split();

    println!("Waiting for messages...\n");

    // 接收 5 条消息
    let mut count = 0;
    while let Some(msg) = read.next().await {
        match msg? {
            Message::Text(text) => {
                println!("Raw[{}]: {}", count, &text[..text.len().min(200)]);

                match serde_json::from_str::<DirectKlineMessage>(&text) {
                    Ok(msg) => {
                        println!("  -> Parsed: e={}, s={}", msg.e, msg.s);
                        if let Some(k) = &msg.k {
                            println!("  -> Kline: t={}, x={}, o={}, c={}", k.t, k.x, k.o, k.c);
                        }
                    }
                    Err(e) => {
                        println!("  -> Parse error: {}", e);
                    }
                }
                println!();

                count += 1;
                if count >= 5 {
                    break;
                }
            }
            Message::Close(_) => {
                println!("Connection closed");
                break;
            }
            _ => {}
        }
    }

    println!("Done!");
    Ok(())
}