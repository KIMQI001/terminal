//! 数据库操作模块

use sqlx::{sqlite::SqlitePoolOptions, Pool, Sqlite};
use crate::types::Kline;
use anyhow::Result;

pub type DbPool = Pool<Sqlite>;

/// 初始化数据库连接池
pub async fn init_db(database_url: &str) -> Result<DbPool> {
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await?;

    // 运行迁移
    sqlx::query(include_str!("../../migrations/001_init.sql"))
        .execute(&pool)
        .await?;

    Ok(pool)
}

/// K线数据仓库
pub struct KlineRepository {
    pool: DbPool,
}

impl KlineRepository {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// 插入或更新单条K线
    pub async fn upsert_kline(&self, kline: &Kline) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO klines (symbol, timeframe, open_time, open, high, low, close, volume, close_time, quote_volume, trades, is_closed, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
            ON CONFLICT(symbol, timeframe, open_time) DO UPDATE SET
                high = MAX(excluded.high, klines.high),
                low = MIN(excluded.low, klines.low),
                close = excluded.close,
                volume = excluded.volume,
                quote_volume = excluded.quote_volume,
                trades = excluded.trades,
                is_closed = excluded.is_closed,
                updated_at = strftime('%s', 'now')
            "#,
        )
        .bind(&kline.symbol)
        .bind(&kline.timeframe)
        .bind(kline.open_time)
        .bind(kline.open)
        .bind(kline.high)
        .bind(kline.low)
        .bind(kline.close)
        .bind(kline.volume)
        .bind(kline.close_time)
        .bind(kline.quote_volume)
        .bind(kline.trades)
        .bind(kline.is_closed)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// 批量插入K线
    pub async fn batch_insert_klines(&self, klines: &[Kline]) -> Result<()> {
        if klines.is_empty() {
            return Ok(());
        }

        // SQLite 批量插入使用事务
        let mut tx = self.pool.begin().await?;

        for kline in klines {
            sqlx::query(
                r#"
                INSERT INTO klines (symbol, timeframe, open_time, open, high, low, close, volume, close_time, quote_volume, trades, is_closed, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
                ON CONFLICT(symbol, timeframe, open_time) DO UPDATE SET
                    high = MAX(excluded.high, klines.high),
                    low = MIN(excluded.low, klines.low),
                    close = excluded.close,
                    volume = excluded.volume,
                    quote_volume = excluded.quote_volume,
                    trades = excluded.trades,
                    is_closed = excluded.is_closed,
                    updated_at = strftime('%s', 'now')
                "#,
            )
            .bind(&kline.symbol)
            .bind(&kline.timeframe)
            .bind(kline.open_time)
            .bind(kline.open)
            .bind(kline.high)
            .bind(kline.low)
            .bind(kline.close)
            .bind(kline.volume)
            .bind(kline.close_time)
            .bind(kline.quote_volume)
            .bind(kline.trades)
            .bind(kline.is_closed)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    /// 查询K线数据
    pub async fn get_klines(
        &self,
        symbol: &str,
        timeframe: &str,
        limit: i64,
        end_time: Option<i64>,
    ) -> Result<Vec<Kline>> {
        let query = match end_time {
            Some(et) => {
                sqlx::query_as::<_, KlineRow>(
                    r#"
                    SELECT symbol, timeframe, open_time, open, high, low, close, volume, close_time, quote_volume, trades, is_closed
                    FROM klines
                    WHERE symbol = ? AND timeframe = ? AND open_time <= ?
                    ORDER BY open_time DESC
                    LIMIT ?
                    "#,
                )
                .bind(symbol)
                .bind(timeframe)
                .bind(et)
                .bind(limit)
            }
            None => {
                sqlx::query_as::<_, KlineRow>(
                    r#"
                    SELECT symbol, timeframe, open_time, open, high, low, close, volume, close_time, quote_volume, trades, is_closed
                    FROM klines
                    WHERE symbol = ? AND timeframe = ?
                    ORDER BY open_time DESC
                    LIMIT ?
                    "#,
                )
                .bind(symbol)
                .bind(timeframe)
                .bind(limit)
            }
        };

        let rows = query.fetch_all(&self.pool).await?;

        // 转换并反转顺序（使最早的在前）
        let mut klines: Vec<Kline> = rows.into_iter().map(|r| r.into()).collect();
        klines.reverse();

        Ok(klines)
    }

    /// 获取最新的K线时间
    pub async fn get_latest_kline_time(
        &self,
        symbol: &str,
        timeframe: &str,
    ) -> Result<Option<i64>> {
        let result: Option<(i64,)> = sqlx::query_as(
            "SELECT MAX(open_time) FROM klines WHERE symbol = ? AND timeframe = ?",
        )
        .bind(symbol)
        .bind(timeframe)
        .fetch_optional(&self.pool)
        .await?;

        Ok(result.map(|r| r.0))
    }

    /// 删除旧数据（保留最近N条）
    pub async fn cleanup_old_klines(
        &self,
        symbol: &str,
        timeframe: &str,
        keep_count: i64,
    ) -> Result<u64> {
        let result = sqlx::query(
            r#"
            DELETE FROM klines
            WHERE symbol = ? AND timeframe = ? AND open_time NOT IN (
                SELECT open_time FROM klines
                WHERE symbol = ? AND timeframe = ?
                ORDER BY open_time DESC
                LIMIT ?
            )
            "#,
        )
        .bind(symbol)
        .bind(timeframe)
        .bind(symbol)
        .bind(timeframe)
        .bind(keep_count)
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected())
    }
}

/// SQLx 查询结果行
#[derive(sqlx::FromRow)]
struct KlineRow {
    symbol: String,
    timeframe: String,
    open_time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
    close_time: i64,
    quote_volume: f64,
    trades: i64,
    is_closed: i64,
}

impl From<KlineRow> for Kline {
    fn from(row: KlineRow) -> Self {
        Self {
            symbol: row.symbol,
            timeframe: row.timeframe,
            open_time: row.open_time,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
            close_time: row.close_time,
            quote_volume: row.quote_volume,
            trades: row.trades,
            is_closed: row.is_closed != 0,
        }
    }
}
