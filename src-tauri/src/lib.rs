//! PoolTerminal — Rust backend entry.
//!
//! Phase 0: minimal Tauri shell. No commands registered yet.
//!
//! Future phases will register:
//!   - SSH connection commands (russh-based)
//!   - cncli SQLite query commands
//!   - Prometheus scrape commands
//!   - Local cache (rusqlite) read/write commands
//!   - Koios fetch commands
//!
//! HARDFORK: era-aware code paths will be added here as fork support lands.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
