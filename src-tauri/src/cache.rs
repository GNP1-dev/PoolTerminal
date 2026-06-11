//! PoolTerminal — local SQLite cache (rusqlite, bundled SQLite).
//!
//! Purpose: persist collected stats locally so HISTORY views grow richer over
//! time — most of this data can't be retrieved retroactively from any API.
//!
//! Schema is deliberately generic so it doesn't churn as metrics are added:
//!   - epoch_snapshots : one JSON payload per (pool_id, epoch)
//!   - samples         : generic time-series (metric, value) for fine graphs
//!   - delegator_stake : per-delegator, per-epoch active stake + pool (immutable
//!                       once an epoch closes) — backs loyalty / migration views
//!   - meta            : schema version + app state
//!
//! Concurrency: SQLite calls are synchronous, so we use std::sync::Mutex and
//! these commands are NOT async — the lock never crosses an `.await`. This is
//! the deliberate counterpart to the SSH layer's tokio::sync::Mutex.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

const SCHEMA_VERSION: i64 = 3;

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
            CREATE TABLE IF NOT EXISTS delegator_stake (
                pool_id    TEXT    NOT NULL,
                stake_addr TEXT    NOT NULL,
                epoch      INTEGER NOT NULL,
                deleg_pool TEXT    NOT NULL,
                amount     INTEGER NOT NULL,
                PRIMARY KEY (pool_id, stake_addr, epoch)
            );
            CREATE INDEX IF NOT EXISTS idx_delegstake_addr
                ON delegator_stake (pool_id, stake_addr);
            CREATE TABLE IF NOT EXISTS delegator_loyalty (
                pool_id          TEXT    NOT NULL,
                stake_addr       TEXT    NOT NULL,
                tenure           INTEGER NOT NULL,
                since_epoch      INTEGER NOT NULL,
                cur_stake        INTEGER NOT NULL,
                reduction_factor REAL    NOT NULL DEFAULT 0,
                defected         INTEGER NOT NULL DEFAULT 0,
                defect_to_pool   TEXT,
                defect_epoch     INTEGER,
                defect_to_ada    INTEGER,
                computed_epoch   INTEGER NOT NULL,
                PRIMARY KEY (pool_id, stake_addr)
            );
            CREATE INDEX IF NOT EXISTS idx_deloyalty_pool
                ON delegator_loyalty (pool_id, computed_epoch);
            ",
        )?;
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegatorStakeRow {
    pub epoch: i64,
    pub deleg_pool: String,
    pub amount: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegatorStakeInput {
    pub epoch: i64,
    pub deleg_pool: String,
    pub amount: i64,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoyaltyRow {
    pub stake: String,
    pub tenure: i64,
    pub since_epoch: i64,
    pub cur_stake: i64,
    pub reduction_factor: f64,
    pub defected: bool,
    pub defect_to_pool: Option<String>,
    pub defect_epoch: Option<i64>,
    pub defect_to_ada: Option<i64>,
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

// ------------------------------------------------------------
// delegator_stake — per-delegator, per-epoch active stake + pool.
// Past epochs are immutable on-chain, so once stored they never need
// re-fetching; only the current epoch's row is overwritten. Backs the
// loyalty leaderboard and aggregate migration views. Writes are batched
// in a single transaction for speed during the initial bulk populate.
// ------------------------------------------------------------

#[tauri::command]
pub fn cache_put_delegator_stake(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
    stake_addr: String,
    rows: Vec<DelegatorStakeInput>,
) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO delegator_stake (pool_id, stake_addr, epoch, deleg_pool, amount)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(pool_id, stake_addr, epoch) DO UPDATE SET
                    deleg_pool = excluded.deleg_pool,
                    amount     = excluded.amount",
            )
            .map_err(|e| e.to_string())?;
        for r in &rows {
            stmt.execute(rusqlite::params![
                pool_id,
                stake_addr,
                r.epoch,
                r.deleg_pool,
                r.amount
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cache_get_delegator_stake(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
    stake_addr: String,
) -> Result<Vec<DelegatorStakeRow>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT epoch, deleg_pool, amount FROM delegator_stake
             WHERE pool_id = ?1 AND stake_addr = ?2
             ORDER BY epoch ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![pool_id, stake_addr], |row| {
            Ok(DelegatorStakeRow {
                epoch: row.get(0)?,
                deleg_pool: row.get(1)?,
                amount: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Highest epoch already stored for a delegator (or null if none) — lets the JS
/// side fetch ONLY epochs newer than this, so after the first populate we make
/// near-zero calls.
#[tauri::command]
pub fn cache_delegator_max_epoch(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
    stake_addr: String,
) -> Result<Option<i64>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let val = conn
        .query_row(
            "SELECT MAX(epoch) FROM delegator_stake
             WHERE pool_id = ?1 AND stake_addr = ?2",
            rusqlite::params![pool_id, stake_addr],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(val)
}

/// Replace the whole loyalty snapshot for a pool (computed once per epoch). We
/// wipe the pool's prior rows and insert the fresh set in one transaction, then
/// the JS side reads it back instantly on subsequent opens.
#[tauri::command]
pub fn cache_put_loyalty(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
    computed_epoch: i64,
    rows: Vec<LoyaltyRow>,
) -> Result<(), String> {
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        tx.execute("DELETE FROM delegator_loyalty WHERE pool_id = ?1", rusqlite::params![pool_id])
            .map_err(|e| e.to_string())?;
        let mut stmt = tx
            .prepare(
                "INSERT INTO delegator_loyalty
                   (pool_id, stake_addr, tenure, since_epoch, cur_stake,
                    reduction_factor, defected, defect_to_pool, defect_epoch,
                    defect_to_ada, computed_epoch)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            )
            .map_err(|e| e.to_string())?;
        for r in &rows {
            stmt.execute(rusqlite::params![
                pool_id,
                r.stake,
                r.tenure,
                r.since_epoch,
                r.cur_stake,
                r.reduction_factor,
                if r.defected { 1 } else { 0 },
                r.defect_to_pool,
                r.defect_epoch,
                r.defect_to_ada,
                computed_epoch,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the cached loyalty snapshot for a pool (empty if none).
#[tauri::command]
pub fn cache_get_loyalty(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
) -> Result<Vec<LoyaltyRow>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT stake_addr, tenure, since_epoch, cur_stake, reduction_factor,
                    defected, defect_to_pool, defect_epoch, defect_to_ada
             FROM delegator_loyalty WHERE pool_id = ?1
             ORDER BY tenure DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![pool_id], |row| {
            Ok(LoyaltyRow {
                stake: row.get(0)?,
                tenure: row.get(1)?,
                since_epoch: row.get(2)?,
                cur_stake: row.get(3)?,
                reduction_factor: row.get(4)?,
                defected: row.get::<_, i64>(5)? != 0,
                defect_to_pool: row.get(6)?,
                defect_epoch: row.get(7)?,
                defect_to_ada: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Which epoch the cached loyalty was computed for (null if none) — lets JS
/// decide whether to recompute (new epoch) or read the cache.
#[tauri::command]
pub fn cache_loyalty_epoch(
    state: tauri::State<'_, CacheState>,
    pool_id: String,
) -> Result<Option<i64>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let val = conn
        .query_row(
            "SELECT MAX(computed_epoch) FROM delegator_loyalty WHERE pool_id = ?1",
            rusqlite::params![pool_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(val)
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
