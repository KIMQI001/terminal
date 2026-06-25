/**
 * CLI 入口：15m ICT 塔块检测
 * 用法: npm run blocks-15m BTCUSDC [limit]
 */

import { detect15mBlocks } from './ictBlocks15m';

async function main() {
  const symbol = (process.argv[2] || 'BTCUSDC').toUpperCase();
  const limit = parseInt(process.argv[3] || '1000', 10);

  console.log(`\n=== 15m ICT 塔块检测 ===`);
  console.log(`交易对: ${symbol}, K线数: ${limit}\n`);

  const result = await detect15mBlocks(symbol, limit);

  if (!result) {
    console.error('检测失败');
    process.exit(1);
  }

  console.log(`\n=== 检测结果 ===`);
  console.log(`当前价格: ${result.currentPrice}`);
  console.log(`时间: ${result.timestamp}`);
  console.log(`\n--- 原始数据 ---`);
  console.log(`Swing Points: ${result.raw.swingPoints.length}`);
  console.log(`FVG: ${result.raw.fvgs.length}`);
  console.log(`OrderBlocks: ${result.raw.orderBlocks.length}`);
  console.log(`OTE Zones: ${result.raw.oteZones.length}`);

  console.log(`\n--- 塔块汇总 (${result.blocks.length} 个) ---`);
  console.log(JSON.stringify(result.blocks, null, 2));

  // 同时输出 raw 详细数据
  console.log(`\n--- FVG 详细 ---`);
  console.log(JSON.stringify(result.raw.fvgs, null, 2));

  console.log(`\n--- OrderBlock 详细 ---`);
  console.log(JSON.stringify(result.raw.orderBlocks, null, 2));

  console.log(`\n--- OTE 详细 ---`);
  console.log(JSON.stringify(result.raw.oteZones, null, 2));
}

main().catch(err => {
  console.error('CLI 错误:', err);
  process.exit(1);
});
