# look-left-right

「最长波段」6 价位框架策略服务(Rust)。

## 它做什么

把前端「最长波段」面板(仅 admin 可见)上的 6 个价位变成一套自动挂单策略:

1. **框架**:图上最近 5 个 swing high + 5 个 swing low 组成的最长波段,以及沿该波段
   HH / LL 射线**向左**扫到的两根 K 线:
   - 阳线行(做空):`阳O` / `阳H` / `阳C`
   - 阴线行(做多):`阴O` / `阴L` / `阴C`
2. **触发判定**:与面板的浅红框完全一致 —— 从波段的 HH / LL **之后**开始,后续 K 线的
   价格区间"遮挡"了某个价位,说明该价位**已经被触发过**。
3. **建仓**:6 个价位里只要有**任意一个**被触发 → 框架成立 → 给**其余未触发**的价位
   挂入场单(阶梯)。
4. **止损 / 止盈**:止 200 点,止盈 1000 点(绝对点数)。
5. **成交后**:一旦有持仓 → 撤掉其余入场挂单,只留止盈 / 止损。
6. **下单量**:按余额比例 —— 总保证金 = 余额 × `margin_pct`,平均分给阶梯上的每一档,
   数量 = 该档保证金 × 杠杆 ÷ 价格。

挂单类型按价位与现价的关系自动选择:

| 方向 | 价位相对现价 | 挂单类型 |
|------|--------------|----------|
| 做空(SELL) | 在现价**上方** | STOP_MARKET(等价格涨到该价位再成交) |
| 做空(SELL) | 在现价**下方** | LIMIT(等价格回落下来成交) |
| 做多(BUY)  | 在现价**下方** | LIMIT |
| 做多(BUY)  | 在现价**上方** | STOP_MARKET |

## 运行

前置:kline-server(`cd ../kline-server && cargo run --release`)已在 3001 端口跑着。

```bash
cd look-left-right
cp .env.example .env
cargo build --release
RUST_LOG=info ./target/release/look-left-right
```

默认监听 `127.0.0.1:3005`。

## HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/frame?symbol=BTCUSDC&timeframe=15m` | 只算框架(不需要密钥),用于跟前端面板对账 |
| GET | `/status` | 策略状态(状态机 / 挂单 / 持仓 / 框架快照) |
| POST | `/config` | 配置并启动策略(需带 api_key / api_secret) |
| POST | `/stop` | 停止策略并撤掉自己挂的入场单 |

`POST /config` 的 body:

```json
{
  "user_id": 1,
  "symbol": "BTCUSDC",
  "exchange": "binance",
  "timeframe": "15m",
  "api_key": "...",
  "api_secret": "...",
  "is_testnet": false,
  "margin_pct": 0.375,
  "sl_points": 200,
  "tp_points": 1000,
  "leverage": 20,
  "poll_interval_sec": 5,
  "dry_run": true
}
```

前端通过 `POST /api/look-left-right/config` 调用,密钥在 Next.js 代理里解密后注入
(`src/app/api/look-left-right/[...path]/route.ts`)。

> **`dry_run` 默认 true**:只算不发单。真实下单必须显式传 `dry_run: false`。

## 状态机

| 状态 | 含义 |
|------|------|
| `idle` | 未启动 |
| `waiting` | 运行中,等待框架成立(或等待新的触发) |
| `armed` | 框架已成立,阶梯挂单已挂出,等待成交 |
| `in_position` | 已有持仓,其余挂单已撤,只留止盈止损 |
| `stopped` | 已停止 |

## 模块

| 文件 | 作用 |
|------|------|
| `src/detector.rs` | swing point 检测 + 「最长波段」框架计算(与前端 `pivotDetector.ts` / `LongestSwingPanel.tsx` 严格对齐) |
| `src/kline.rs` | 从 kline-server 拉 K 线 |
| `src/binance.rs` | Binance USDⓈ-M Futures REST 客户端(签名 / 限价单 / 算法单 / 撤单 / 查仓查余额) |
| `src/strategy.rs` | 策略状态机 + 挂单 / 撤单 / 止盈止损 |
| `src/api.rs` | axum HTTP 接口 |
