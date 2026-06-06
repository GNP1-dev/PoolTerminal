//! PoolTerminal — Postgres (db-sync) query command.
//!
//! One command covers every topology; the connection params decide the mode:
//!   • no host           → local Unix socket, peer auth   (PT + db-sync same box)
//!   • host+port+user+pw → remote TCP                      (db-sync on another box)
//!
//! Read-only by intent: the db-sync source only ever SELECTs. Rows are returned
//! as an array of string-keyed maps (all values stringified) so the JS side
//! parses/casts exactly as it does for the psql / Koios paths — one row shape.
//!
//! CONTRACT: db-sync queries MUST cast every selected column to ::text. db-sync's
//! big numeric domains (lovelace, word63/64/128type, numeric) exceed i64/f64 and
//! have custom OIDs tokio-postgres can't map — casting to text makes every value
//! a String here, preserving full precision (stake/reward sums routinely > 2^53),
//! which the JS side turns into BigInt/Number as needed.

use serde::{Deserialize, Serialize};
use tokio_postgres::{types::Type, NoTls, Row};

#[derive(Debug, Deserialize)]
pub struct PgConn {
    /// Database name (e.g. "cexplorer"). Required.
    pub database: String,
    /// Omit/empty for local socket + peer auth.
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PgResult {
    pub columns: Vec<String>,
    /// Each row is a list of optional strings, column-aligned. NULL → None.
    pub rows: Vec<Vec<Option<String>>>,
}

/// Build a libpq-style connection string from the params.
/// Leaving host unset makes libpq use the local Unix socket (peer auth) — this
/// is the all-on-one-box / PT-local case and needs no credentials.
///
/// tokio-postgres (unlike libpq) does NOT auto-default the user or the socket
/// path, so for the local case we fill them in: user → the OS user, host → the
/// standard Postgres socket directory. This makes peer auth "just work" for the
/// basic operator without them entering a username.
fn conn_string(c: &PgConn) -> String {
    let mut parts = vec![format!("dbname={}", c.database)];

    let host_set = c.host.as_deref().map(|h| !h.is_empty()).unwrap_or(false);
    if host_set {
        parts.push(format!("host={}", c.host.as_deref().unwrap()));
    } else {
        // Local peer auth: point at the standard Unix socket directory so
        // tokio-postgres uses the socket rather than failing on a missing host.
        let sock = first_existing_socket_dir();
        parts.push(format!("host={}", sock));
    }

    if let Some(p) = c.port {
        parts.push(format!("port={}", p));
    }

    let user_set = c.user.as_deref().map(|u| !u.is_empty()).unwrap_or(false);
    if user_set {
        parts.push(format!("user={}", c.user.as_deref().unwrap()));
    } else {
        // Default to the OS user (peer auth maps OS user → PG role).
        let os_user = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_else(|_| "postgres".to_string());
        parts.push(format!("user={}", os_user));
    }

    if let Some(pw) = &c.password {
        if !pw.is_empty() {
            parts.push(format!("password={}", pw));
        }
    }
    // Fail fast rather than hang if a remote host is unreachable.
    parts.push("connect_timeout=8".to_string());
    parts.join(" ")
}

/// First standard Postgres socket directory that exists, else the common default.
fn first_existing_socket_dir() -> String {
    for d in ["/var/run/postgresql", "/run/postgresql", "/tmp"] {
        if std::path::Path::new(d).exists() {
            return d.to_string();
        }
    }
    "/var/run/postgresql".to_string()
}

/// Stringify a single column value by its Postgres type. db-sync uses big
/// numeric domains (lovelace, word63/64/128type) that exceed i64/f64 range, so
/// numerics are read as their text representation to preserve full precision —
/// the JS side BigInts them. This is critical: active stake and reward sums are
/// routinely > 2^53.
fn value_to_string(row: &Row, idx: usize) -> Option<String> {
    let col = &row.columns()[idx];
    let ty = col.type_();
    // Try text-yielding reads first (covers numeric/decimal domains safely).
    match *ty {
        Type::INT2 => row.get::<_, Option<i16>>(idx).map(|v| v.to_string()),
        Type::INT4 => row.get::<_, Option<i32>>(idx).map(|v| v.to_string()),
        Type::INT8 => row.get::<_, Option<i64>>(idx).map(|v| v.to_string()),
        Type::FLOAT4 => row.get::<_, Option<f32>>(idx).map(|v| v.to_string()),
        Type::FLOAT8 => row.get::<_, Option<f64>>(idx).map(|v| v.to_string()),
        Type::BOOL => row.get::<_, Option<bool>>(idx).map(|v| v.to_string()),
        Type::TEXT | Type::VARCHAR | Type::NAME | Type::BPCHAR => {
            row.get::<_, Option<String>>(idx)
        }
        // NUMERIC and db-sync's custom domains (lovelace, word*type) deserialize
        // as text via tokio-postgres' Decimal-as-string fallback. We read them
        // as String to keep full precision.
        _ => match row.try_get::<_, Option<String>>(idx) {
            Ok(v) => v,
            Err(_) => {
                // Last resort: numeric read as f64 (lossy) so we never panic.
                row.try_get::<_, Option<i64>>(idx)
                    .ok()
                    .flatten()
                    .map(|v| v.to_string())
            }
        },
    }
}

/// Run a read-only SQL statement and return columns + rows.
/// `params` are passed positionally ($1, $2, …) as text — db-sync queries here
/// use only the pool hex and epoch bounds, all safe as text/int via casts in SQL.
#[tauri::command]
pub async fn pg_query(conn: PgConn, sql: String) -> Result<PgResult, String> {
    let cs = conn_string(&conn);
    let (client, connection) = tokio_postgres::connect(&cs, NoTls)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    // Drive the connection in the background; it ends when `client` drops.
    let handle = tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("[pg] connection error: {e}");
        }
    });

    let result = async {
        let rows = client
            .query(sql.as_str(), &[])
            .await
            .map_err(|e| format!("query failed: {e}"))?;

        let columns: Vec<String> = if let Some(first) = rows.first() {
            first.columns().iter().map(|c| c.name().to_string()).collect()
        } else {
            Vec::new()
        };

        let out: Vec<Vec<Option<String>>> = rows
            .iter()
            .map(|r| (0..r.columns().len()).map(|i| value_to_string(r, i)).collect())
            .collect();

        Ok::<PgResult, String>(PgResult { columns, rows: out })
    }
    .await;

    drop(client); // closes the connection task
    let _ = handle.await;
    result
}
