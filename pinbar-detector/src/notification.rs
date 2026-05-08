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

/// 发送 Markdown 消息到钉钉
pub async fn send_dingtalk_markdown(title: &str, text: &str) -> anyhow::Result<()> {
    let webhook = std::env::var("DINGTALK_WEBHOOK")
        .expect("DINGTALK_WEBHOOK must be set");

    let message = DingtalkMessage {
        msgtype: "markdown",
        markdown: DingtalkMarkdown {
            title: title.to_string(),
            text: text.to_string(),
        },
    };

    let client = reqwest::Client::new();
    let response = client
        .post(&webhook)
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
