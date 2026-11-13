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
6. **平仓后**:自动按**剩余未触发**的价位重新挂单(跳刚开仓过的那个价位,防同价位反复开仓)。
7. **下单量**:按余额比例 —— **总保证金 = 余额 × `margin_pct`,再平均分给阶梯上的每一档**,
   数量 = 该档保证金 × 杠杆 ÷ 价格。

   例(余额 30 USDT、`margin_pct` 0.9、2 个未触发价位、杠杆 100x):

   ```
   总保证金 = 30 × 0.9 = 27 USDT
   每档保证金 = 27 ÷ 2 = 13.5 USDT
   每档名义   = 13.5 × 100 = 1350 USDT   (数量 = 1350 ÷ 价位,向下取整到 0.001)
   ```

   面板「总保证金比例」改的就是这个 `margin_pct`(默认 0.9),面板上会直接把这条算式显示出来。

挂单类型按价位与现价的关系自动选择:

| 方向 | 价位相对现价 | 挂单类型 |
|------|--------------|----------|
| 做空(SELL) | 在现价**上方** | STOP_MARKET(等价格涨到该价位再成交) |
| 做空(SELL) | 在现价**下方** | LIMIT(等价格回落下来成交) |
| 做多(BUY)  | 在现价**下方** | LIMIT |
| 做多(BUY)  | 在现价**上方** | STOP_MARKET |

### 安全兜底(避免真金白银的裸仓)

| 场景 | 处理 |
|------|------|
| 价格**已经越过**止损价 / 止盈价(条件单会被 Binance 以 -2021 拒单) | 直接市价平仓(`MARKET` + `reduceOnly`),等价于止损 / 止盈已触发 |
| 仓位已平但保护单还挂着 | 撤掉残留的 `llr_sl*` / `llr_tp*` 条件单(否则会反向开仓) |
| 多空反手,残留旧方向保护单 | 撤掉 `positionSide` 与当前持仓不符的保护单 |
| 价位已经被价格越过去(限价单会立刻成交) | 跳过该档并告警,不下这个"追价"单 |
| 数量取整后为 0 | 跳过该档(不占用保证金) |

> 止损 / 止盈的方向校验与市价平仓逻辑,和线上在跑的 `wick-sr-detector/src/order.rs`
> (`validate_stop_price` / `place_close_position_market`)保持一致。

## 运行

前置:kline-server(`cd ../kline-server && cargo run --release`)已在 3001 端口跑着。

```bash
cd look-left-right
cp .env.example .env
cargo build --release
RUST_LOG=info ./target/release/look-left-right
```

默认监听 `127.0.0.1:3005`。

### 服务器部署(和 kline-server 一样用 pm2)

```bash
cd /var/www/terminal && git pull
cd look-left-right && cargo build --release
pm2 start ./target/release/look-left-right --name look-left-right --cwd /var/www/terminal/look-left-right
pm2 save && pm2 startup
```

前端不需要额外配置:Next.js 代理默认连 `http://127.0.0.1:3005`
(可用环境变量 `LOOK_LEFT_RIGHT_API` 覆盖)。

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
  "margin_pct": 0.9,
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
| `waiting` | 运行中,**还没有任何价位被触发过** → 框架不成立,先不挂单 |
| `waiting_trigger` | 本轮框架已经挂过单,还没有**新的**价位被触发(平仓后会自动按剩余未触发价位重新挂) |
| `armed` | 框架已成立,阶梯挂单已挂出,等待成交 |
| `in_position` | 已有持仓,其余挂单已撤,只留止盈止损 |
| `stopped` | 已停止 |

> `waiting` / `waiting_trigger` 时 `/status` 会带 `wait_reason`,前端面板直接显示具体原因,
> 不用再猜「等待框架成立」到底卡在哪一步。

### 状态流转

```
启动 → waiting(还没价位被触发)
     → armed(有价位被触发 → 给其余未触发价位挂单)
     → in_position(挂单成交 → 撤掉其余入场单,只留止盈止损)
     → armed(平仓 → 按**剩余未触发**价位重新挂单,不会在同一价位反复开仓)
     → waiting_trigger(挂单被外部撤掉 / 还没有新触发)
```

## 模块

| 文件 | 作用 |
|------|------|
| `src/detector.rs` | swing point 检测 + 「最长波段」框架计算(与前端 `pivotDetector.ts` / `LongestSwingPanel.tsx` 严格对齐) |
| `src/kline.rs` | 从 kline-server 拉 K 线 |
| `src/binance.rs` | Binance USDⓈ-M Futures REST 客户端(签名 / 限价单 / 算法单 / 撤单 / 查仓查余额) |
| `src/strategy.rs` | 策略状态机 + 挂单 / 撤单 / 止盈止损 |
| `src/api.rs` | axum HTTP 接口 |
