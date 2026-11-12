#![allow(dead_code)]

/**
 * look-left-right —— 「最长波段」6 价位框架策略服务
 *
 * 规则(用户定义):
 * - 框架:图上最近 5 个 swing high + 5 个 swing low 组成的最长波段,以及它沿 HH/LL
 *   射线向左扫到的阳线(阳O/阳H/阳C,做空)和阴线(阴O/阴L/阴C,做多)共 6 个价位。
 * - 触发:波段 HH/LL **之后**的 K 线遮挡了某个价位 → 该价位已触发(面板上的浅红框)。
 * - 建仓:6 个价位里任意一个被触发 → 框架成立 → 给**其余未触发**的价位挂单。
 * - 止损 200 点 / 止盈 1000 点;一旦有持仓 → 撤掉其余挂单,只留止盈止损。
 * - 下单量按余额比例(余额 × margin_pct,平均分给阶梯每一档)。
 *
 * 运行:PORT=3005(默认) cargo run --release
 */

mod api;
mod binance;
mod detector;
mod kline;
mod strategy;
mod types;

use std::net::SocketAddr;
use std::sync::Arc;

use tracing_subscriber::EnvFilter;

use crate::strategy::Engine;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // .env(可选)
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3005);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    let engine = Arc::new(Engine::new());

    // 后台策略轮询
    {
        let engine = engine.clone();
        tokio::spawn(async move {
            engine.run().await;
        });
    }

    let app = api::router(engine);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("[look-left-right] 监听 http://{}", addr);

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("安装 ctrl-c handler 失败");
    };
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("安装 SIGTERM handler 失败")
            .recv()
            .await;
    };
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("[look-left-right] 收到退出信号,关闭服务");
}
