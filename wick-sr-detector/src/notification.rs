//! 钉钉 + Telegram 推送(简化版)

use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;

#[derive(Clone)]
pub struct NotifyConfig {
    pub dingtalk_webhook: Option<String>,
    pub dingtalk_secret: Option<String>,
    pub telegram_token: Option<String>,
    pub telegram_chat_id: Option<String>,
}

impl NotifyConfig {
    pub fn from_env() -> Self {
        let _ = dotenvy::dotenv();
        Self {
            dingtalk_webhook: env::var("DINGTALK_WEBHOOK").ok().filter(|s| !s.is_empty()),
            dingtalk_secret: env::var("DINGTALK_SECRET").ok().filter(|s| !s.is_empty()),
            telegram_token: env::var("TELEGRAM_BOT_TOKEN").ok().filter(|s| !s.is_empty()),
            telegram_chat_id: env::var("TELEGRAM_CHAT_ID").ok().filter(|s| !s.is_empty()),
        }
    }
}

/// 发送 Markdown 到钉钉
pub async fn send_dingtalk(config: &NotifyConfig, title: &str, text: &str) -> Result<()> {
    let webhook = match &config.dingtalk_webhook {
        Some(u) => u,
        None => return Ok(()),
    };
    let url = if let Some(secret) = &config.dingtalk_secret {
        let ts = chrono::Utc::now().timestamp_millis();
        let string_to_sign = format!("{}\n{}", ts, secret);
        use hmac::{Hmac, Mac};
        type HmacSha256 = Hmac<sha2::Sha256>;
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(string_to_sign.as_bytes());
        let result = mac.finalize();
        let sign_bytes = result.into_bytes();
        use base64::Engine;
        let b64_sign = base64::engine::general_purpose::STANDARD.encode(&sign_bytes);
        let sign = urlencoding::encode(&b64_sign);
        format!("{}&timestamp={}&sign={}", webhook, ts, sign)
    } else {
        webhook.clone()
    };

    let client = Client::new();
    let body = serde_json::json!({
        "msgtype": "markdown",
        "markdown": { "title": title, "text": text }
    });
    let resp = client.post(&url).json(&body).send().await
        .context("dingtalk send")?;
    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow::Error::msg(format!(
            "dingtalk failed: status={}, body={}",
            status, body_text
        )));
    }
    // 钉钉 200 但 errcode != 0 也会"成功发送但不显示"
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body_text) {
        if v.get("errcode").and_then(|x| x.as_i64()) != Some(0) {
            return Err(anyhow::Error::msg(format!(
                "dingtalk returned ok but errcode != 0: {}",
                body_text
            )));
        }
    }
    Ok(())
}

/// 发送 Markdown 到 Telegram
pub async fn send_telegram(config: &NotifyConfig, text: &str) -> Result<()> {
    let (token, chat_id) = match (&config.telegram_token, &config.telegram_chat_id) {
        (Some(t), Some(c)) => (t, c),
        _ => return Ok(()),
    };
    let url = format!("https://api.telegram.org/bot{}/sendMessage", token);
    let client = Client::new();
    client.post(&url).json(&serde_json::json!({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
    })).send().await.context("telegram send")?;
    Ok(())
}

/// 同时推钉钉 + Telegram
pub async fn broadcast(config: &NotifyConfig, title: &str, text: &str) -> Result<()> {
    send_dingtalk(config, title, text).await?;
    send_telegram(config, text).await?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct _DingtalkResp {
    errcode: i32,
    errmsg: String,
}
