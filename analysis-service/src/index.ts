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
dotenv.config({ path: '../.env.local' });

import { config, validateConfig } from './config';
import { startScheduler } from './scheduler';
import { sendDingtalkMarkdown } from './notification/dingtalk';
import { formatStartupMessage } from './notification/formatter';
import { initDatabase, closeDatabase } from './db';
import { startSignalTracker } from './signals/signalTracker';
import { startReviewScheduler } from './review/reviewScheduler';
import { startApiServer } from './api';
import { startOrderMonitor, stopOrderMonitor } from './order/orderMonitor';
import { getFirstBinanceApiConfig, closeApiConfigReader } from './order/apiConfigReader';
import { startTowerScheduler, stopTowerScheduler } from './tower/towerScheduler';

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════');
  console.log('🤖 ICT + AI 分析服务 v2.0');
  console.log('═══════════════════════════════════════');

  // 验证配置
  validateConfig();

  // 初始化数据库
  initDatabase();

  // 发送启动通知
  if (config.dingtalk.webhook) {
    const startupMsg = formatStartupMessage();
    await sendDingtalkMarkdown('分析服务启动', startupMsg);
  }

  // 启动 HTTP API 服务器
  startApiServer(3002);

  // 启动信号跟踪器（每分钟检查价格）
  startSignalTracker();

  // 启动复盘调度器（每日/每周）
  startReviewScheduler();

  // 启动主调度器
  startScheduler();

  // 启动订单监控器（守塔订单成交后自动下止盈止损）
  const apiConfig = getFirstBinanceApiConfig();
  if (apiConfig) {
    console.log(`[OrderMonitor] 找到用户 ${apiConfig.userId} 的 Binance 配置`);
    await startOrderMonitor({
      apiKey: apiConfig.config.apiKey,
      apiSecret: apiConfig.config.apiSecret,
      isTestnet: apiConfig.config.isTestnet,
    });
  } else {
    console.warn('[OrderMonitor] 未找到 Binance API 配置，订单监控未启动');
  }

  // 启动守塔托管调度器（后台定时执行守塔策略）
  startTowerScheduler();
}

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n📴 收到 SIGINT 信号，正在退出...');
  stopTowerScheduler();
  stopOrderMonitor();
  closeApiConfigReader();
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n📴 收到 SIGTERM 信号，正在退出...');
  stopTowerScheduler();
  stopOrderMonitor();
  closeApiConfigReader();
  closeDatabase();
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
