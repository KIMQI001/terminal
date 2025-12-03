/**
 * 分析服务入口
 *
 * ICT + AI 交易分析服务
 * - 定时获取 K线和清算数据
 * - 计算 ICT 指标
 * - 调用 Claude AI 生成交易建议
 * - 推送到钉钉
 */

// 加载环境变量 (必须在最前面)
import * as dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import { config, validateConfig } from './config';
import { startScheduler } from './scheduler';
import { sendDingtalkMarkdown } from './notification/dingtalk';
import { formatStartupMessage } from './notification/formatter';

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════');
  console.log('🤖 ICT + AI 分析服务');
  console.log('═══════════════════════════════════════');

  // 验证配置
  validateConfig();

  // 发送启动通知
  if (config.dingtalk.webhook) {
    const startupMsg = formatStartupMessage();
    await sendDingtalkMarkdown('分析服务启动', startupMsg);
  }

  // 启动调度器
  startScheduler();
}

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n📴 收到 SIGINT 信号，正在退出...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n📴 收到 SIGTERM 信号，正在退出...');
  process.exit(0);
});

// 未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获的异常:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ 未处理的 Promise 拒绝:', reason);
});

// 启动
main().catch((error) => {
  console.error('❌ 启动失败:', error);
  process.exit(1);
});
