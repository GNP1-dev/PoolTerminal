//! PoolTerminal — local SSH key discovery.
//!
//! Lists candidate private keys in the LOCAL ~/.ssh directory (the machine
//! PoolTerminal runs on — the SSH *client* side, where the private key lives).
//! Lets the connect UI offer a pick-list so the user never has to know or type
//! a key path. Read-only: lists files, never reads key contents.

use serde::Serialize;

#[derive(Serialize)]
pub struct SshKey {
    /// Display name, e.g. "id_ed25519".
    pub name: String,
    /// Absolute path, e.g. "/home/russell/.ssh/id_ed25519".
    pub path: String,
    /// Best-guess key type from the filename, for the UI label.
    pub kind: String,
}

/// Return private keys found in ~/.ssh, most-preferred first.
/// A "private key" here = a file whose name matches a known key name and which
/// is NOT a .pub file. We don't parse the key (no secrets read); we only list.
#[tauri::command]
pub fn list_ssh_keys() -> Result<Vec<SshKey>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "could not resolve home directory".to_string())?;
    let ssh_dir = std::path::Path::new(&home).join(".ssh");
    if !ssh_dir.is_dir() {
        return Ok(Vec::new());
    }

    // Preference order: ed25519 (modern, what most relays use) → ecdsa → rsa.
    let preferred = ["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

    let mut found: Vec<SshKey> = Vec::new();
    let entries = std::fs::read_dir(&ssh_dir).map_err(|e| format!("read ~/.ssh failed: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Skip public keys, known_hosts, config, authorized_keys, etc.
        if name.ends_with(".pub")
            || name == "known_hosts"
            || name == "known_hosts.old"
            || name == "config"
            || name == "authorized_keys"
            || name.starts_with('.')
        {
            continue;
        }
        // Accept standard key names, plus any file that has a matching .pub
        // sibling (covers custom-named keys like "relay_key").
        let has_pub = ssh_dir.join(format!("{name}.pub")).is_file();
        let is_standard = preferred.contains(&name.as_str());
        if !is_standard && !has_pub {
            continue;
        }
        let kind = if name.contains("ed25519") {
            "ED25519"
        } else if name.contains("ecdsa") {
            "ECDSA"
        } else if name.contains("rsa") {
            "RSA"
        } else if name.contains("dsa") {
            "DSA"
        } else {
            "key"
        }
        .to_string();
        found.push(SshKey {
            name: name.clone(),
            path: path.to_string_lossy().into_owned(),
            kind,
        });
    }

    // Sort: preferred names first (in preference order), then the rest A–Z.
    found.sort_by_key(|k| {
        let rank = preferred.iter().position(|p| *p == k.name).unwrap_or(usize::MAX);
        (rank, k.name.clone())
    });

    Ok(found)
}
