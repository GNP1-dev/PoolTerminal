//! PoolTerminal — Rust backend entry.
//!
//! Phase 0: Tauri shell + async SSH layer.
//!
//! Registered commands:
//!   - ssh_connect / ssh_run / ssh_disconnect / ssh_is_connected
//!
//! Future phases will register:
//!   - cncli SQLite query commands
//!   - Prometheus scrape commands
//!   - Local cache (rusqlite) read/write commands
//!   - Koios fetch commands
//!
//! HARDFORK: era-aware code paths will be added here as fork support lands.

mod ssh;

use ssh::SshState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SshState::default())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_run,
            ssh::ssh_disconnect,
            ssh::ssh_is_connected,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
