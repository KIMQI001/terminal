-- K线数据表
CREATE TABLE IF NOT EXISTS klines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,           -- 交易对，如 BTCUSDT
    timeframe TEXT NOT NULL,        -- 时间周期，如 1m, 5m, 1h
    open_time INTEGER NOT NULL,     -- 开盘时间戳（秒）
    open REAL NOT NULL,             -- 开盘价
    high REAL NOT NULL,             -- 最高价
    low REAL NOT NULL,              -- 最低价
    close REAL NOT NULL,            -- 收盘价
    volume REAL NOT NULL,           -- 成交量
    close_time INTEGER NOT NULL,    -- 收盘时间戳（秒）
    quote_volume REAL NOT NULL,     -- 成交额
    trades INTEGER NOT NULL,        -- 成交笔数
    is_closed INTEGER NOT NULL DEFAULT 1,  -- 是否收盘（1=是，0=否）
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 索引：按交易对、时间周期和开盘时间查询
CREATE UNIQUE INDEX IF NOT EXISTS idx_klines_unique
ON klines(symbol, timeframe, open_time);

-- 索引：按时间范围查询
CREATE INDEX IF NOT EXISTS idx_klines_time_range
ON klines(symbol, timeframe, open_time DESC);

-- 订阅管理表（跟踪活跃的交易对订阅）
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    client_count INTEGER NOT NULL DEFAULT 0,  -- 订阅该交易对的客户端数量
    last_update INTEGER,                       -- 最后更新时间
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(symbol, timeframe)
);
