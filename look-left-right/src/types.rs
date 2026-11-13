/**
 * look-left-right 公共类型
 *
 * - Candle:与前端 src/types/chart 的 Candle 一致(time = 秒级时间戳)
 * - SwingPoint / Leg / Level / Frame:「最长波段」面板的数据结构(Rust 侧复刻)
 */

use serde::{Deserialize, Serialize};

// ============== K 线 ==============

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candle {
    /// Unix 时间戳(秒),kline-server 的 open_time
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    #[serde(default)]
    pub volume: f64,
}

impl Candle {
    pub fn is_bull(&self) -> bool {
        self.close > self.open
    }

    pub fn is_bear(&self) -> bool {
        self.close < self.open
    }

    /// 水平射线是否"扫到"这根 K 线(价格区间覆盖该价位)
    pub fn covers(&self, level: f64) -> bool {
        self.low <= level && level <= self.high
    }
}

// ============== Swing ==============

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PivotType {
    High,
    Low,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SwingPoint {
    #[serde(rename = "type")]
    pub pivot_type: PivotType,
    pub price: f64,
    pub time: i64,
    pub index: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Leg {
    pub from: SwingPoint,
    pub to: SwingPoint,
    /// 带符号价格变化
    pub change: f64,
    /// 带符号涨跌幅(%)
    pub percent: f64,
    /// 绝对幅度
    pub amplitude: f64,
    /// 跨越 K 线根数
    pub bars: usize,
    /// 时间跨度(秒)
    pub duration_sec: i64,
    pub up: bool,
}

// ============== 触发价位 ==============

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    /// 做多 / BUY
    Buy,
    /// 做空 / SELL
    Sell,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LevelKind {
    /// 阳线行(HH 射线扫到的阳线)→ 做空
    Bull,
    /// 阴线行(LL 射线扫到的阴线)→ 做多
    Bear,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Level {
    /// 标签:阳O / 阳H / 阳C / 阴O / 阴L / 阴C
    pub label: String,
    pub price: f64,
    pub side: Side,
    pub kind: LevelKind,
    /// 所属 pivot(HH 或 LL)
    pub pivot_label: String,
    /// 是否已被波段 pivot 之后的 K 线遮挡(= 已触发,面板里的浅红框)
    pub covered: bool,
    /// 最早遮挡到它的 K 线时间(秒)
    pub covered_at: Option<i64>,
}

/// 一个「框架」:幅度最大的波段 + 它的 6 个价位
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Frame {
    pub leg: Leg,
    /// 持续时间最长的波段(与 leg 不同才为 Some)
    pub duration_leg: Option<Leg>,
    pub hh: SwingPoint,
    pub ll: SwingPoint,
    pub hh_index: usize,
    pub ll_index: usize,
    /// 阳线行:阳O / 阳H / 阳C(做空)
    pub bull_levels: Vec<Level>,
    /// 阴线行:阴O / 阴L / 阴C(做多)
    pub bear_levels: Vec<Level>,
}

impl Frame {
    /// 全部 6 个价位
    pub fn all_levels(&self) -> Vec<&Level> {
        self.bull_levels.iter().chain(self.bear_levels.iter()).collect()
    }

    /// 已被触发(红框)的价位
    pub fn covered_levels(&self) -> Vec<&Level> {
        self.all_levels().into_iter().filter(|l| l.covered).collect()
    }

    /// 未被触发的价位 —— 策略要在这些价位挂单
    pub fn uncovered_levels(&self) -> Vec<&Level> {
        self.all_levels().into_iter().filter(|l| !l.covered).collect()
    }

    /// 框架是否成立(至少一个价位已被触发)
    pub fn is_established(&self) -> bool {
        self.all_levels().iter().any(|l| l.covered)
    }

    /// 波段标识:HH 时间 + LL 时间。波段变了说明换了一个框架。
    pub fn leg_signature(&self) -> (i64, i64) {
        (self.hh.time, self.ll.time)
    }
}

// ============== 配置 / 状态 ==============

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StrategyConfig {
    pub user_id: i64,
    pub symbol: String,
    /// binance / aster(目前只实现 binance 的下单,aster 走同一套 Binance 兼容 API)
    pub exchange: String,
    pub timeframe: String,
    pub api_key: String,
    pub api_secret: String,
    #[serde(default)]
    pub is_testnet: bool,
    /// 总保证金预算 = 余额 × margin_pct,再平均分给阶梯上的每个单
    /// (例:余额 30、margin_pct 0.9、2 个未触发价位 → 总保证金 27,每档 13.5)
    #[serde(default = "default_margin_pct")]
    pub margin_pct: f64,
    /// 止损点数(绝对值)
    #[serde(default = "default_sl_points")]
    pub sl_points: f64,
    /// 止盈点数(绝对值)
    #[serde(default = "default_tp_points")]
    pub tp_points: f64,
    /// 杠杆(读取不到交易所设置时的兜底值)
    #[serde(default = "default_leverage")]
    pub leverage: u32,
    /// 轮询间隔(秒)
    #[serde(default = "default_poll_interval")]
    pub poll_interval_sec: u64,
    /// 只算不发单(dry run)
    #[serde(default)]
    pub dry_run: bool,
}

fn default_margin_pct() -> f64 {
    0.9
}
fn default_sl_points() -> f64 {
    200.0
}
fn default_tp_points() -> f64 {
    1000.0
}
fn default_leverage() -> u32 {
    20
}
fn default_poll_interval() -> u64 {
    5
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyState {
    /// 未启动
    Idle,
    /// 运行中,等待框架成立
    Waiting,
    /// 框架已成立,阶梯挂单已挂出,等待成交
    Armed,
    /// 已有持仓,其余挂单已撤,只留止盈止损
    InPosition,
    /// 已停止
    Stopped,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlacedOrder {
    pub client_order_id: String,
    pub label: String,
    pub price: f64,
    pub side: Side,
    pub quantity: f64,
    pub order_type: String,
    pub order_id: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StrategyStatus {
    pub state: StrategyState,
    pub running: bool,
    pub symbol: String,
    pub timeframe: String,
    pub exchange: String,
    pub user_id: i64,
    pub dry_run: bool,
    pub margin_pct: f64,
    pub sl_points: f64,
    pub tp_points: f64,
    pub current_price: Option<f64>,
    pub balance: Option<f64>,
    pub leverage: Option<u32>,
    /// 已建立框架时的波段标识
    pub armed_leg: Option<(i64, i64)>,
    /// 当前框架里**未触发**的价位数量(决定保证金怎么分档)
    pub uncovered_count: Option<usize>,
    pub frame: Option<Frame>,
    pub orders: Vec<PlacedOrder>,
    /// 第一个持仓(兼容旧字段;多空两边都有仓位时用 positions 看全)
    pub position: Option<PositionInfo>,
    /// 当前全部持仓(hedge 模式下可能同时有 LONG 和 SHORT)
    pub positions: Vec<PositionInfo>,
    pub last_error: Option<String>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PositionInfo {
    pub position_side: String,
    pub amount: f64,
    pub entry_price: f64,
    pub quantity: f64,
}
