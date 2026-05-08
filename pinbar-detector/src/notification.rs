//! 钉钉通知模块

use serde::{Deserialize, Serialize};

/// 钉钉消息
#[derive(Debug, Serialize)]
struct DingtalkMessage {
    msgtype: &'static str,
    markdown: DingtalkMarkdown,
}

#[derive(Debug, Serialize)]
struct DingtalkMarkdown {
    title: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct DingtalkResponse {
    errcode: i32,
    errmsg: String,
}

/// 生成钉钉签名 (HMAC-SHA256 + Base64)
fn generate_sign(timestamp: i64, secret: &str) -> String {
    let string_to_sign = format!("{}\n{}", timestamp, secret);
    let key = secret.as_bytes();

    // 使用 hmac crate
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;

    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(string_to_sign.as_bytes());
    let result = mac.finalize();

    // Base64 编码
    let sign = base64_encode(&result.into_bytes());

    // URL encode
    urlencoding::encode(&sign).to_string()
}

/// Base64 编码
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as i32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as i32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as i32;

        result.push(ALPHABET[((b0 >> 2) & 0x3F) as usize] as char);
        result.push(ALPHABET[(((b0 << 4) | (b1 >> 4)) & 0x3F) as usize] as char);

        if chunk.len() > 1 {
            result.push(ALPHABET[(((b1 << 2) | (b2 >> 6)) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(ALPHABET[(b2 & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }

    result
}

/// 发送 Markdown 消息到钉钉
pub async fn send_dingtalk_markdown(title: &str, text: &str) -> anyhow::Result<()> {
    // 钉钉 Webhook 配置
    let webhook = "https://oapi.dingtalk.com/robot/send?access_token=55406d8790e82483e866e9388c2877befe9c69fb188e63b090e1b5563479fb1f";
    let secret = "SECc84a436bc1f37629247c2a4dd9179554862537943b904075b2bf207fc3db0219";

    // 生成签名
    let timestamp = chrono::Utc::now().timestamp_millis();
    let sign = generate_sign(timestamp, secret);
    let url = format!("{}&timestamp={}&sign={}", webhook, timestamp, sign);

    let message = DingtalkMessage {
        msgtype: "markdown",
        markdown: DingtalkMarkdown {
            title: title.to_string(),
            text: text.to_string(),
        },
    };

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(&message)
        .send()
        .await?;

    let result: DingtalkResponse = response.json().await?;

    if result.errcode != 0 {
        anyhow::bail!("钉钉 API 错误: {}", result.errmsg);
    }

    println!("[Dingtalk] 消息发送成功: {}", title);
    Ok(())
}
