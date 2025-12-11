/**
 * 滚仓服务 API
 * - GET: 获取滚仓状态
 * - POST: 启动滚仓
 * - DELETE: 停止滚仓
 */

import { NextRequest, NextResponse } from 'next/server';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { verifyToken, extractTokenFromHeader } from '@/lib/auth';
import { getDecryptedApiConfig } from '@/lib/apiConfig';

// 滚仓服务目录
const ROLLING_SERVICE_DIR = path.join(process.cwd(), 'rolling-service');
const CONFIG_FILE = path.join(ROLLING_SERVICE_DIR, 'config.toml');
const BINARY_PATH = path.join(ROLLING_SERVICE_DIR, 'target/release/rolling-service');

// 支持的交易对精度配置
const SYMBOL_PRECISION: Record<string, { price: number; quantity: number }> = {
  'ETHUSDC': { price: 2, quantity: 3 },
  'BTCUSDC': { price: 2, quantity: 3 },
};

// 存储运行中的进程（按用户ID）
const rollingProcesses: Map<number, ChildProcess> = new Map();
const rollingStatuses: Map<number, {
  isRunning: boolean;
  direction: 'long' | 'short' | null;
  symbol: string | null;
  startTime: Date | null;
  config: RollingConfig | null;
}> = new Map();

// 验证用户身份
async function authenticateUser(request: NextRequest): Promise<{ userId: number; username: string } | null> {
  const authHeader = request.headers.get('Authorization');
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    return null;
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return null;
  }

  return { userId: payload.userId, username: payload.username };
}

interface RollingConfig {
  symbol: string;
  leverage: number;
  gridSpacing: number;
  gridCount: number;
  orderSize: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  useRollingMargin: boolean;
  rollProfitRatio: number;
  maxPosition: number;
  targetPrice: number;
  stopRollDistance: number;
}

interface PositionInfo {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  positionSide: string;
  unRealizedProfit: string;
}

// 获取 Binance 持仓信息
async function getBinancePosition(
  symbol: string,
  apiKey: string,
  apiSecret: string
): Promise<{ direction: 'long' | 'short' | null; position: PositionInfo | null }> {
  const timestamp = Date.now();
  const queryString = `symbol=${symbol}&timestamp=${timestamp}`;

  // 生成签名
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');

  const url = `https://fapi.binance.com/fapi/v2/positionRisk?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Binance API 错误: ${text}`);
  }

  const positions: PositionInfo[] = await response.json();

  // 查找 LONG 和 SHORT 持仓
  const longPos = positions.find(p => p.positionSide === 'LONG' && parseFloat(p.positionAmt) > 0);
  const shortPos = positions.find(p => p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);

  if (longPos && shortPos) {
    // 双向持仓，不滚
    return { direction: null, position: null };
  } else if (longPos) {
    return { direction: 'long', position: longPos };
  } else if (shortPos) {
    return { direction: 'short', position: shortPos };
  }

  return { direction: null, position: null };
}

// 生成配置文件
function generateConfig(
  config: RollingConfig,
  direction: 'long' | 'short',
  apiKey: string,
  apiSecret: string,
  userId: number
): string {
  const precision = SYMBOL_PRECISION[config.symbol] || { price: 2, quantity: 3 };

  return `# 滚仓策略配置 - 自动生成 (用户ID: ${userId})

[binance]
api_key = "${apiKey}"
api_secret = "${apiSecret}"
api_url = "https://fapi.binance.com"
ws_url = "wss://fstream.binance.com/ws"

[grid]
symbol = "${config.symbol}"
direction = "${direction}"
grid_spacing = ${config.gridSpacing}
grid_count = ${config.gridCount}
order_size = ${config.orderSize}
leverage = ${config.leverage}
price_precision = ${precision.price}
quantity_precision = ${precision.quantity}

[rolling]
take_profit_percent = ${config.takeProfitPercent}
stop_loss_percent = ${config.stopLossPercent}
use_rolling_margin = ${config.useRollingMargin}
roll_profit_ratio = ${config.rollProfitRatio}
max_position = ${config.maxPosition}
target_price = ${config.targetPrice}
stop_roll_distance = ${config.stopRollDistance}
`;
}

// GET: 获取滚仓状态
export async function GET(request: NextRequest) {
  try {
    const user = await authenticateUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: '未授权' },
        { status: 401 }
      );
    }

    const status = rollingStatuses.get(user.userId) || {
      isRunning: false,
      direction: null,
      symbol: null,
      startTime: null,
      config: null,
    };

    return NextResponse.json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error('[rolling] GET error:', error);
    return NextResponse.json(
      { success: false, error: '获取状态失败' },
      { status: 500 }
    );
  }
}

// POST: 启动滚仓
export async function POST(request: NextRequest) {
  try {
    // 1. 验证用户身份
    const user = await authenticateUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: '未授权' },
        { status: 401 }
      );
    }

    // 检查是否已有运行中的服务
    const existingStatus = rollingStatuses.get(user.userId);
    if (existingStatus?.isRunning) {
      return NextResponse.json(
        { success: false, error: '滚仓服务已在运行' },
        { status: 400 }
      );
    }

    // 2. 获取用户的 API 配置
    const apiConfig = await getDecryptedApiConfig(user.userId, 'binance_futures');
    if (!apiConfig) {
      return NextResponse.json(
        { success: false, error: '未配置 Binance API 密钥' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const config: RollingConfig = {
      symbol: body.symbol || 'ETHUSDC',
      leverage: body.leverage || 20,
      gridSpacing: body.gridSpacing || 1.0,
      gridCount: body.gridCount || 10,
      orderSize: body.orderSize || 0.01,
      takeProfitPercent: body.takeProfitPercent || 5,
      stopLossPercent: body.stopLossPercent || 3,
      useRollingMargin: body.useRollingMargin ?? true,
      rollProfitRatio: body.rollProfitRatio || 80,
      maxPosition: body.maxPosition || 1,
      targetPrice: body.targetPrice || 0,
      stopRollDistance: body.stopRollDistance || 1,
    };

    // 3. 检测当前持仓方向
    const { direction, position } = await getBinancePosition(
      config.symbol,
      apiConfig.apiKey,
      apiConfig.apiSecret
    );

    if (!direction) {
      return NextResponse.json(
        { success: false, error: '无法滚仓：没有单向持仓（需要先开仓）' },
        { status: 400 }
      );
    }

    console.log(`[rolling] 用户${user.userId} 检测到${direction === 'long' ? '多头' : '空头'}持仓:`, position);

    // 4. 生成配置文件（使用用户ID作为后缀避免冲突）
    const userConfigFile = path.join(ROLLING_SERVICE_DIR, `config_${user.userId}.toml`);
    const configContent = generateConfig(config, direction, apiConfig.apiKey, apiConfig.apiSecret, user.userId);
    fs.writeFileSync(userConfigFile, configContent);
    console.log('[rolling] 配置文件已写入:', userConfigFile);

    // 5. 检查二进制文件是否存在
    if (!fs.existsSync(BINARY_PATH)) {
      return NextResponse.json(
        { success: false, error: '滚仓服务二进制文件不存在，请先编译' },
        { status: 500 }
      );
    }

    // 6. 启动滚仓服务
    console.log(`[rolling] 用户${user.userId} 启动滚仓服务...`);
    const rollingProcess = spawn(BINARY_PATH, ['--config', userConfigFile], {
      cwd: ROLLING_SERVICE_DIR,
      env: { ...process.env, RUST_LOG: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 存储进程
    rollingProcesses.set(user.userId, rollingProcess);

    // 收集日志
    rollingProcess.stdout?.on('data', (data) => {
      console.log(`[rolling-service:${user.userId}]`, data.toString().trim());
    });

    rollingProcess.stderr?.on('data', (data) => {
      console.error(`[rolling-service:${user.userId}]`, data.toString().trim());
    });

    rollingProcess.on('exit', (code) => {
      console.log(`[rolling] 用户${user.userId} 服务已退出, code=${code}`);
      rollingStatuses.set(user.userId, {
        isRunning: false,
        direction: null,
        symbol: null,
        startTime: null,
        config: null,
      });
      rollingProcesses.delete(user.userId);
      // 清理配置文件
      try {
        fs.unlinkSync(userConfigFile);
      } catch {
        // ignore
      }
    });

    // 更新状态
    rollingStatuses.set(user.userId, {
      isRunning: true,
      direction,
      symbol: config.symbol,
      startTime: new Date(),
      config,
    });

    return NextResponse.json({
      success: true,
      message: `滚仓服务已启动 (${direction === 'long' ? '做多' : '做空'})`,
      data: {
        direction,
        position: position ? {
          quantity: parseFloat(position.positionAmt),
          entryPrice: parseFloat(position.entryPrice),
          pnl: parseFloat(position.unRealizedProfit),
        } : null,
        config,
      },
    });
  } catch (error) {
    console.error('[rolling] POST error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '启动失败' },
      { status: 500 }
    );
  }
}

// DELETE: 停止滚仓
export async function DELETE(request: NextRequest) {
  try {
    const user = await authenticateUser(request);
    if (!user) {
      return NextResponse.json(
        { success: false, error: '未授权' },
        { status: 401 }
      );
    }

    const status = rollingStatuses.get(user.userId);
    const rollingProcess = rollingProcesses.get(user.userId);

    if (!status?.isRunning || !rollingProcess) {
      return NextResponse.json(
        { success: false, error: '滚仓服务未在运行' },
        { status: 400 }
      );
    }

    // 发送 SIGTERM 信号
    rollingProcess.kill('SIGTERM');

    // 等待进程退出
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        const proc = rollingProcesses.get(user.userId);
        if (proc) {
          proc.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      rollingProcess.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    rollingStatuses.set(user.userId, {
      isRunning: false,
      direction: null,
      symbol: null,
      startTime: null,
      config: null,
    });
    rollingProcesses.delete(user.userId);

    return NextResponse.json({
      success: true,
      message: '滚仓服务已停止',
    });
  } catch (error) {
    console.error('[rolling] DELETE error:', error);
    return NextResponse.json(
      { success: false, error: '停止失败' },
      { status: 500 }
    );
  }
}
