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

/// 生成钉钉签名 (HMAC-SHA256)
fn generate_sign(timestamp: i64, secret: &str) -> String {
    let string_to_sign = format!("{}\n{}", timestamp, secret);
    let key = secret.as_bytes();

    // 使用 hmac crate
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;

    let mut mac = HmacSha256::new_from_slice(key).unwrap();
    mac.update(string_to_sign.as_bytes());
    let result = mac.finalize();

    // 转换为 hex 字符串
    let sign: String = result
        .into_bytes()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    // URL encode
    urlencoding::encode(&sign).to_string()
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
