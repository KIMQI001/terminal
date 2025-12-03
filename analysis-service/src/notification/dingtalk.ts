/**
 * 钉钉机器人推送模块
 * 使用 Webhook + HMAC-SHA256 签名
 */

import crypto from 'crypto';
import { config } from '../config';

interface DingtalkMessage {
  msgtype: 'markdown' | 'text';
  markdown?: {
    title: string;
    text: string;
  };
  text?: {
    content: string;
  };
}

interface DingtalkResponse {
  errcode: number;
  errmsg: string;
}

/**
 * 生成签名
 */
function generateSign(timestamp: number, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(stringToSign);
  return encodeURIComponent(hmac.digest('base64'));
}

/**
 * 发送 Markdown 消息
 */
export async function sendDingtalkMarkdown(
  title: string,
  content: string
): Promise<boolean> {
  if (!config.dingtalk.webhook || !config.dingtalk.secret) {
    console.error('[Dingtalk] 未配置 Webhook 或 Secret');
    return false;
  }

  const timestamp = Date.now();
  const sign = generateSign(timestamp, config.dingtalk.secret);

  const url = `${config.dingtalk.webhook}&timestamp=${timestamp}&sign=${sign}`;

  const message: DingtalkMessage = {
    msgtype: 'markdown',
    markdown: {
      title,
      text: content,
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.error(`[Dingtalk] HTTP 错误: ${response.status}`);
      return false;
    }

    const result = await response.json() as DingtalkResponse;

    if (result.errcode !== 0) {
      console.error(`[Dingtalk] API 错误: ${result.errmsg}`);
      return false;
    }

    console.log('[Dingtalk] 消息发送成功');
    return true;
  } catch (error) {
    console.error('[Dingtalk] 发送失败:', error);
    return false;
  }
}

/**
 * 发送文本消息
 */
export async function sendDingtalkText(content: string): Promise<boolean> {
  if (!config.dingtalk.webhook || !config.dingtalk.secret) {
    console.error('[Dingtalk] 未配置 Webhook 或 Secret');
    return false;
  }

  const timestamp = Date.now();
  const sign = generateSign(timestamp, config.dingtalk.secret);

  const url = `${config.dingtalk.webhook}&timestamp=${timestamp}&sign=${sign}`;

  const message: DingtalkMessage = {
    msgtype: 'text',
    text: {
      content,
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.error(`[Dingtalk] HTTP 错误: ${response.status}`);
      return false;
    }

    const result = await response.json() as DingtalkResponse;

    if (result.errcode !== 0) {
      console.error(`[Dingtalk] API 错误: ${result.errmsg}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Dingtalk] 发送失败:', error);
    return false;
  }
}
