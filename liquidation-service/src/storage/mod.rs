use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

/// 爆仓记录
#[derive(Debug, Clone)]
pub struct ForceOrder {
    pub symbol: String,
    pub side: String,           // BUY = 空头被清算, SELL = 多头被清算
    pub price: f64,             // 清算价
    pub quantity: f64,          // 清算数量
    pub quote_qty: f64,         // 清算金额 (USDT)
    pub market_price: f64,      // 当时市价
    pub estimated_leverage: u32, // 估算杠杆
    pub timestamp: i64,         // 毫秒时间戳
}

/// 杠杆分布统计
#[derive(Debug, Clone)]
pub struct LeverageStat {
    pub symbol: String,
    pub leverage: u32,
    pub ratio: f64,
    pub sample_count: u32,
    pub updated_at: DateTime<Utc>,
}

/// 聚合交易记录（用于清算计算）
#[derive(Debug, Clone)]
pub struct AggTradeRecord {
    pub symbol: String,
    pub price: f64,
    pub quantity: f64,
    pub quote_qty: f64,
    pub is_buyer_maker: bool,  // true=卖单成交(做空), false=买单成交(做多)
    pub timestamp: i64,
}

/// SQLite 存储
pub struct Storage {
    conn: Mutex<Connection>,
}

impl Storage {
    /// 创建存储实例
    pub fn new<P: AsRef<Path>>(db_path: P) -> Result<Self> {
        // 确保目录存在
        if let Some(parent) = db_path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(db_path)?;
        let storage = Self {
            conn: Mutex::new(conn),
        };
        storage.init_tables()?;
        Ok(storage)
    }

    /// 初始化表结构
    fn init_tables(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        // 爆仓记录表
        conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS force_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                price REAL NOT NULL,
                quantity REAL NOT NULL,
                quote_qty REAL NOT NULL,
                market_price REAL NOT NULL,
                estimated_leverage INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
            "#,
            [],
        )?;

        // 创建索引
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_force_orders_symbol ON force_orders(symbol)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_force_orders_timestamp ON force_orders(timestamp)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_force_orders_leverage ON force_orders(estimated_leverage)",
            [],
        )?;

        // 杠杆分布统计表
        conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS leverage_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                leverage INTEGER NOT NULL,
                ratio REAL NOT NULL,
                sample_count INTEGER NOT NULL,
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(symbol, leverage)
            )
            "#,
            [],
        )?;

        // 聚合交易记录表（用于精确计算清算分布）
        conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS agg_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                price REAL NOT NULL,
                quantity REAL NOT NULL,
                quote_qty REAL NOT NULL,
                is_buyer_maker INTEGER NOT NULL,
                timestamp INTEGER NOT NULL
            )
            "#,
            [],
        )?;

        // 创建 agg_trades 索引
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_agg_trades_symbol_time ON agg_trades(symbol, timestamp)",
            [],
        )?;

        Ok(())
    }

    /// 保存爆仓记录
    pub fn save_force_order(&self, order: &ForceOrder) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO force_orders
            (symbol, side, price, quantity, quote_qty, market_price, estimated_leverage, timestamp)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                order.symbol,
                order.side,
                order.price,
                order.quantity,
                order.quote_qty,
                order.market_price,
                order.estimated_leverage,
                order.timestamp,
            ],
        )?;
        Ok(())
    }

    /// 批量保存爆仓记录
    pub fn save_force_orders(&self, orders: &[ForceOrder]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        for order in orders {
            tx.execute(
                r#"
                INSERT INTO force_orders
                (symbol, side, price, quantity, quote_qty, market_price, estimated_leverage, timestamp)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    order.symbol,
                    order.side,
                    order.price,
                    order.quantity,
                    order.quote_qty,
                    order.market_price,
                    order.estimated_leverage,
                    order.timestamp,
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    /// 获取杠杆分布统计（基于最近 N 天的数据）
    pub fn get_leverage_distribution(&self, symbol: &str, days: u32) -> Result<Vec<(u32, f64)>> {
        let conn = self.conn.lock().unwrap();
        let cutoff = chrono::Utc::now().timestamp_millis() - (days as i64 * 24 * 60 * 60 * 1000);

        // 按杠杆分组统计，用清算金额加权
        let mut stmt = conn.prepare(
            r#"
            SELECT
                estimated_leverage,
                SUM(quote_qty) as total_qty
            FROM force_orders
            WHERE symbol = ?1 AND timestamp > ?2
            GROUP BY estimated_leverage
            ORDER BY estimated_leverage
            "#,
        )?;

        let rows = stmt.query_map(params![symbol, cutoff], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, f64>(1)?))
        })?;

        let leverage_qtys: Vec<(u32, f64)> = rows.filter_map(|r| r.ok()).collect();

        // 计算总量
        let total: f64 = leverage_qtys.iter().map(|(_, qty)| qty).sum();

        if total == 0.0 {
            return Ok(vec![]);
        }

        // 转换为比例
        let distribution: Vec<(u32, f64)> = leverage_qtys
            .into_iter()
            .map(|(lev, qty)| (lev, qty / total))
            .collect();

        Ok(distribution)
    }

    /// 保存杠杆分布统计
    pub fn save_leverage_stats(&self, symbol: &str, distribution: &[(u32, f64)], sample_count: u32) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        for (leverage, ratio) in distribution {
            tx.execute(
                r#"
                INSERT INTO leverage_stats (symbol, leverage, ratio, sample_count, updated_at)
                VALUES (?1, ?2, ?3, ?4, datetime('now'))
                ON CONFLICT(symbol, leverage) DO UPDATE SET
                    ratio = ?3,
                    sample_count = ?4,
                    updated_at = datetime('now')
                "#,
                params![symbol, leverage, ratio, sample_count],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    /// 获取爆仓记录数量
    pub fn get_force_order_count(&self, symbol: &str) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        let count: u32 = conn.query_row(
            "SELECT COUNT(*) FROM force_orders WHERE symbol = ?1",
            params![symbol],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// 获取最近的爆仓记录
    pub fn get_recent_force_orders(&self, symbol: &str, limit: u32) -> Result<Vec<ForceOrder>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT symbol, side, price, quantity, quote_qty, market_price, estimated_leverage, timestamp
            FROM force_orders
            WHERE symbol = ?1
            ORDER BY timestamp DESC
            LIMIT ?2
            "#,
        )?;

        let rows = stmt.query_map(params![symbol, limit], |row| {
            Ok(ForceOrder {
                symbol: row.get(0)?,
                side: row.get(1)?,
                price: row.get(2)?,
                quantity: row.get(3)?,
                quote_qty: row.get(4)?,
                market_price: row.get(5)?,
                estimated_leverage: row.get(6)?,
                timestamp: row.get(7)?,
            })
        })?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 清理旧数据（保留最近 N 天）
    pub fn cleanup_old_data(&self, days: u32) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        let cutoff = chrono::Utc::now().timestamp_millis() - (days as i64 * 24 * 60 * 60 * 1000);

        let deleted = conn.execute(
            "DELETE FROM force_orders WHERE timestamp < ?1",
            params![cutoff],
        )?;

        Ok(deleted as u32)
    }

    /// 批量保存聚合交易记录
    pub fn save_agg_trades(&self, trades: &[AggTradeRecord]) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        for trade in trades {
            tx.execute(
                r#"
                INSERT INTO agg_trades
                (symbol, price, quantity, quote_qty, is_buyer_maker, timestamp)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![
                    trade.symbol,
                    trade.price,
                    trade.quantity,
                    trade.quote_qty,
                    trade.is_buyer_maker as i32,
                    trade.timestamp,
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    /// 保存单条聚合交易
    pub fn save_agg_trade(&self, trade: &AggTradeRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO agg_trades
            (symbol, price, quantity, quote_qty, is_buyer_maker, timestamp)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![
                trade.symbol,
                trade.price,
                trade.quantity,
                trade.quote_qty,
                trade.is_buyer_maker as i32,
                trade.timestamp,
            ],
        )?;
        Ok(())
    }

    /// 获取指定时间范围的聚合交易
    pub fn get_agg_trades(&self, symbol: &str, start_time: i64, end_time: i64) -> Result<Vec<AggTradeRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT symbol, price, quantity, quote_qty, is_buyer_maker, timestamp
            FROM agg_trades
            WHERE symbol = ?1 AND timestamp >= ?2 AND timestamp <= ?3
            ORDER BY timestamp ASC
            "#,
        )?;

        let rows = stmt.query_map(params![symbol, start_time, end_time], |row| {
            Ok(AggTradeRecord {
                symbol: row.get(0)?,
                price: row.get(1)?,
                quantity: row.get(2)?,
                quote_qty: row.get(3)?,
                is_buyer_maker: row.get::<_, i32>(4)? != 0,
                timestamp: row.get(5)?,
            })
        })?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 获取聚合交易记录数量
    pub fn get_agg_trades_count(&self, symbol: &str) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agg_trades WHERE symbol = ?1",
            params![symbol],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    /// 获取聚合交易最早时间
    pub fn get_agg_trades_min_time(&self, symbol: &str) -> Result<Option<i64>> {
        let conn = self.conn.lock().unwrap();
        let result: Option<i64> = conn.query_row(
            "SELECT MIN(timestamp) FROM agg_trades WHERE symbol = ?1",
            params![symbol],
            |row| row.get(0),
        ).ok();
        Ok(result)
    }

    /// 清理旧的聚合交易（保留最近 N 天）
    pub fn cleanup_old_agg_trades(&self, days: u32) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        let cutoff = chrono::Utc::now().timestamp_millis() - (days as i64 * 24 * 60 * 60 * 1000);

        let deleted = conn.execute(
            "DELETE FROM agg_trades WHERE timestamp < ?1",
            params![cutoff],
        )?;

        Ok(deleted as u32)
    }

    /// 清理旧的聚合交易（保留最近 N 小时）
    pub fn cleanup_old_agg_trades_hours(&self, hours: u32) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        let cutoff = chrono::Utc::now().timestamp_millis() - (hours as i64 * 60 * 60 * 1000);

        let deleted = conn.execute(
            "DELETE FROM agg_trades WHERE timestamp < ?1",
            params![cutoff],
        )?;

        Ok(deleted as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_storage() {
        let storage = Storage::new(":memory:").unwrap();

        let order = ForceOrder {
            symbol: "BTCUSDT".to_string(),
            side: "SELL".to_string(),
            price: 95000.0,
            quantity: 0.1,
            quote_qty: 9500.0,
            market_price: 100000.0,
            estimated_leverage: 20,
            timestamp: chrono::Utc::now().timestamp_millis(),
        };

        storage.save_force_order(&order).unwrap();

        let count = storage.get_force_order_count("BTCUSDT").unwrap();
        assert_eq!(count, 1);

        let orders = storage.get_recent_force_orders("BTCUSDT", 10).unwrap();
        assert_eq!(orders.len(), 1);
        assert_eq!(orders[0].estimated_leverage, 20);
    }
}
