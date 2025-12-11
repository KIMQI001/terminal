# Rolling Service - 滚仓策略服务

基于 Rust 的币安合约滚仓策略服务，支持价格跟随网格补单和浮盈滚仓。

## 功能特性

- **价格跟随网格**：价格移动时自动补单跟随
- **保证金模式**：按 USDT 保证金下单，自动计算数量
- **浮盈滚仓**：用未实现盈利自动加仓
- **目标价止盈**：到达目标价自动平仓
- **止损保护**：基于均价百分比止损
- **双向支持**：支持做多和做空方向

## 配置说明

```toml
[binance]
api_key = "YOUR_API_KEY"
api_secret = "YOUR_API_SECRET"

[grid]
symbol = "ETHUSDC"        # 交易对
direction = "long"        # 方向: long/short
grid_spacing = 1.0        # 网格间距 (USDT)
grid_count = 10           # 网格数量
order_margin = 10         # 每单保证金 (USDT)
max_margin = 100          # 最大保证金 (USDT)，0=不限制
leverage = 20             # 杠杆倍数

[rolling]
target_price = 4000       # 止盈目标价 (必填)
stop_loss_percent = 3     # 止损百分比，0=不设止损
use_rolling_margin = true # 是否用浮盈滚仓
roll_profit_ratio = 80    # 滚仓比例 (%)
stop_roll_distance = 1    # 停止补单距离 (%)
```

## 参数说明

### 网格参数 [grid]

| 参数 | 说明 | 示例 |
|-----|------|------|
| `symbol` | 交易对 | ETHUSDC, BTCUSDC |
| `direction` | 交易方向 | long=做多, short=做空 |
| `grid_spacing` | 网格间距 (USDT) | 1.0 |
| `grid_count` | 网格数量 | 10 |
| `order_margin` | 每单保证金 (USDT) | 10 |
| `max_margin` | 最大保证金 (USDT) | 100 |
| `leverage` | 杠杆倍数 | 20 |

### 滚仓参数 [rolling]

| 参数 | 说明 | 示例 |
|-----|------|------|
| `target_price` | 止盈目标价 | 4000 |
| `stop_loss_percent` | 止损百分比 | 3 (即亏损3%止损) |
| `use_rolling_margin` | 是否滚仓 | true/false |
| `roll_profit_ratio` | 滚仓比例 | 80 (浮盈的80%用于加仓) |
| `stop_roll_distance` | 停止补单距离 | 1 (距目标价1%时停止补单) |

## 策略逻辑

### 下单数量计算
```
数量 = 保证金 × 杠杆 ÷ 价格
```

### 做多模式
1. 在当前价格下方挂买单网格
2. 价格上涨时，跟随补单
3. 达到目标价止盈平仓
4. 跌破止损价止损平仓

### 做空模式
1. 在当前价格上方挂卖单网格
2. 价格下跌时，跟随补单
3. 达到目标价止盈平仓
4. 涨破止损价止损平仓

### 滚仓逻辑
- 当 `use_rolling_margin = true` 时启用
- 浮盈分摊到每个网格格子
- 新补单数量 = 基础数量 + 浮盈分摊数量
- 达到 `max_margin` 后，只用浮盈加仓

### 停止补单
- 当价格接近目标价时自动停止补单
- 停止价 = 目标价 × (1 - stop_roll_distance%) [做多]
- 停止价 = 目标价 × (1 + stop_roll_distance%) [做空]

## 编译运行

```bash
# 编译
cargo build --release

# 运行
./target/release/rolling-service --config config.toml

# 带日志运行
RUST_LOG=info ./target/release/rolling-service --config config.toml
```

## Web 集成

服务通过 `/api/rolling` API 端点集成到 Web 页面：
- `GET` - 获取服务状态
- `POST` - 启动服务（自动检测持仓方向）
- `DELETE` - 停止服务

页面地址：`/rolling`

## 注意事项

1. **必须先开仓**：服务启动前需要有单向持仓（多头或空头）
2. **目标价必填**：必须设置止盈目标价
3. **双向持仓不支持**：同时有多空持仓时无法启动
4. **保证金限制**：达到最大保证金后只能用浮盈加仓
