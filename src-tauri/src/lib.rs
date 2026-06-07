//! PoolTerminal — Rust backend entry.
//!
//! Phase 0: Tauri shell + async SSH layer + local SQLite cache.
//!
//! Registered commands:
//!   - ssh_connect / ssh_run / ssh_disconnect / ssh_is_connected
//!   - cache_put_epoch / cache_get_epochs
//!   - cache_put_sample / cache_get_samples
//!   - cache_meta_set / cache_meta_get
//!   - pg_query                      (db-sync over local socket or remote TCP)
//!
//! Future phases will register:
//!   - cncli SQLite query commands
//!   - Prometheus scrape commands
//!   - Koios fetch commands
//!
//! HARDFORK: era-aware code paths will be added here as fork support lands.

mod cache;
mod localrun;
mod pg;
mod ssh;
mod sshkeys;

use ssh::SshState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SshState::default())
        .setup(|app| {
            // Cache DB lives in the OS-standard app data dir (XDG on Linux).
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("poolterminal.db");
            let cache = cache::CacheState::open(&db_path).map_err(|e| e.to_string())?;
            app.manage(cache);
            eprintln!("[cache] opened at {}", db_path.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_run,
            ssh::ssh_disconnect,
            ssh::ssh_is_connected,
            cache::cache_put_epoch,
            cache::cache_get_epochs,
            cache::cache_put_sample,
            cache::cache_get_samples,
            cache::cache_meta_set,
            cache::cache_meta_get,
            pg::pg_query,
            sshkeys::list_ssh_keys,
            localrun::local_run,
            localrun::local_probe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
