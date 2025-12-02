# Trading Terminal

专业交易终端，支持 ICT 指标系统和多交易所 API 配置。

## 功能特性

### 图表系统
- 实时 K 线图表（基于 lightweight-charts）
- 多周期切换（1m, 5m, 15m, 1h, 4h, 1d, 1w）
- 上海时区显示

### ICT 指标
- **Swing Points** - 摆动高低点
- **Order Blocks (OB)** - 订单块
- **Fair Value Gaps (FVG)** - 公允价值缺口
- **OTE Zones** - 最优交易入场区
- **Breaker Blocks** - 突破块
- **Liquidity Zones** - 流动性区域
- **Killzones** - 交易时段高亮
- **BOS/CHoCH** - 结构突破/特征变化

### 多周期面板
- OTE 面板 - 显示多周期 OTE 入场点
- FVG 面板 - 显示多周期 FVG 区域
- OB 面板 - 显示多周期订单块

### 用户系统
- 用户注册/登录（邀请码制）
- 多交易所 API 配置（Binance, OKX, Bitget, Hyperliquid）
- API 密钥加密存储
- 管理员邀请码管理

## 技术栈

### 前端
- Next.js 14
- React 18
- TypeScript
- Tailwind CSS
- Zustand (状态管理)
- lightweight-charts (图表库)

### 后端
- Next.js API Routes
- SQLite (better-sqlite3)
- JWT 认证 (jose)
- bcrypt 密码加密
- AES-256-GCM API 密钥加密

### K 线服务器
- Rust
- Tokio (异步运行时)
- WebSocket (实时数据)
- 支持 SOCKS5 代理

## 快速开始

### 环境要求
- Node.js 18+
- Rust 1.70+ (K 线服务器)
- pnpm / npm / yarn

### 安装依赖

```bash
# 前端
npm install

# K 线服务器
cd kline-server
cargo build --release
```

### 环境变量

创建 `.env.local` 文件：

```env
# JWT 密钥（必须设置）
JWT_SECRET=your-secret-key-here

# API 加密密钥（必须设置，32字节 hex）
API_ENCRYPTION_KEY=your-32-byte-hex-key
```

### 启动服务

```bash
# 1. 启动 K 线服务器
cd kline-server

# 本地开发（需要代理访问 Binance）
SOCKS5_PROXY=127.0.0.1:7890 RUST_LOG=info ./target/release/kline-server

# 远程部署（直连）
RUST_LOG=info ./target/release/kline-server

# 2. 启动前端（新终端）
npm run dev
```

访问 http://localhost:3000

### 默认管理员账户

首次启动时自动创建：
- 用户名: `admin`
- 密码: `admin123`

> 请登录后立即修改密码！

## 项目结构

```
terminal/
├── src/
│   ├── app/                 # Next.js 页面
│   │   ├── api/            # API 路由
│   │   │   ├── auth/       # 认证 API
│   │   │   ├── admin/      # 管理员 API
│   │   │   └── user/       # 用户 API
│   │   ├── login/          # 登录页
│   │   └── page.tsx        # 主页（图表）
│   ├── components/         # React 组件
│   │   ├── chart/          # 图表组件
│   │   ├── layout/         # 布局组件
│   │   ├── settings/       # 设置组件
│   │   └── trading/        # 交易组件
│   ├── lib/                # 工具库
│   │   ├── binance/        # Binance API
│   │   ├── chart/          # 图表指标
│   │   └── db/             # 数据库
│   ├── stores/             # Zustand stores
│   └── types/              # TypeScript 类型
├── kline-server/           # Rust K 线服务器
│   └── src/
│       ├── exchanges/      # 交易所适配器
│       └── main.rs
├── data/                   # SQLite 数据库文件
└── public/                 # 静态资源
```

## API 配置说明

### Binance
1. 登录 Binance，进入 API 管理
2. 创建 API Key（建议只开启读取权限用于测试）
3. 在设置中填入 API Key 和 Secret

### 注意事项
- API Secret 使用 AES-256-GCM 加密存储
- 建议使用子账户 API，限制权限
- 测试网可用于开发测试

## 部署

### 构建生产版本

```bash
# 前端
npm run build
npm run start

# K 线服务器
cd kline-server
cargo build --release
```

### 环境变量（生产环境）

确保设置以下环境变量：
- `JWT_SECRET` - JWT 签名密钥
- `API_ENCRYPTION_KEY` - API 密钥加密密钥
- `NODE_ENV=production`

## License

MIT
