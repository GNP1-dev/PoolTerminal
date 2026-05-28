//! PoolTerminal — local SQLite cache (rusqlite, bundled SQLite).
//!
//! Purpose: persist collected stats locally so HISTORY views grow richer over
//! time — most of this data can't be retrieved retroactively from any API.
//!
//! Schema is deliberately generic so it doesn't churn as metrics are added:
//!   - epoch_snapshots : one JSON payload per (pool_id, epoch)
//!   - samples         : generic time-series (metric, value) for fine graphs
//!   - meta            : schema version + app state
//!
//! Concurrency: SQLite calls are synchronous, so we use std::sync::Mutex and
//! these commands are NOT async — the lock never crosses an `.await`. This is
//! the deliberate counterpart to the SSH layer's tokio::sync::Mutex.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

const SCHEMA_VERSION: i64 = 1;

pub struct CacheState(pub Mutex<Connection>);

impl CacheState {
    /// Open (or create) the database at `path` and run migrations.
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::migrate(&conn)?;
        Ok(CacheState(Mutex::new(conn)))
    }

    fn migrate(conn: &Connection) -> anyhow::Result<()> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS epoch_snapshots (
                pool_id     TEXT    NOT NULL,
                epoch       INTEGER NOT NULL,
                captured_at INTEGER NOT NULL,
                data        TEXT    NOT NULL,
                PRIMARY KEY (pool_id, epoch)
            );
            CREATE TABLE IF NOT EXISTS samples (
                captured_at INTEGER NOT NULL,
                pool_id     TEXT    NOT NULL,
                metric      TEXT    NOT NULL,
                value       REAL    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_samples_metric_time
                ON samples (pool_id, metric, captured_at);
            ",
        )?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO NOTHING",
            [SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(serde::Serialize)]
pub struct EpochSnapshot {
    pub epoch: i64,
    pub captured_at: i64,
    pub data: serde_json::Value,
}

#[derive(serde::Serialize)]
pub struct Sample {
    pub captured_at: i64,
    pub value: f64,
}

// ============================================================
// Tauri commands (synchronous — run off the UI thread by Tauri)
// ============================================================

#[tauri::command]
pub fn cache_put_epoch(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
    epoch: i64,
    data: serde_json::Value,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO epoch_snapshots (pool_id, epoch, captured_at, data)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(pool_id, epoch) DO UPDATE SET
            captured_at = excluded.captured_at,
            data        = excluded.data",
        rusqlite::params![pool_id, epoch, now_ts(), data.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cache_get_epochs(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
    from_epoch: i64,
    to_epoch: i64,
) -> Result<Vec<EpochSnapshot>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT epoch, captured_at, data FROM epoch_snapshots
             WHERE pool_id = ?1 AND epoch BETWEEN ?2 AND ?3
             ORDER BY epoch ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![pool_id, from_epoch, to_epoch], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for r in rows {
        let (epoch, captured_at, data_str) = r.map_err(|e| e.to_string())?;
        let data = serde_json::from_str(&data_str).map_err(|e| e.to_string())?;
        out.push(EpochSnapshot {
            epoch,
            captured_at,
            data,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn cache_put_sample(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
    metric: String,
    value: f64,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO samples (captured_at, pool_id, metric, value)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![now_ts(), pool_id, metric, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cache_get_samples(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
    metric: String,
    since_ts: i64,
) -> Result<Vec<Sample>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT captured_at, value FROM samples
             WHERE pool_id = ?1 AND metric = ?2 AND captured_at >= ?3
             ORDER BY captured_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![pool_id, metric, since_ts], |row| {
            Ok(Sample {
                captured_at: row.get(0)?,
                value: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn cache_meta_set(
    state: tauri::State<'_, CacheState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cache_meta_get(
    state: tauri::State<'_, CacheState>,
    key: String,
) -> Result<Option<String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let val = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .ok();
    Ok(val)
}
