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
    /// Absolute path, e.g. "/home/you/.ssh/id_ed25519".
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

/// Expand a leading "~" or "~/" to the home directory, as a shell would. Key
/// paths are used as typed (no shell), so "~/.ssh/id_ed25519" failed to load.
/// Other forms ("~user/...") are left unchanged. (key-tilde-v1)
pub fn expand_tilde(path: &str) -> std::path::PathBuf {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok();
    expand_tilde_with(path, home.as_deref())
}

fn expand_tilde_with(path: &str, home: Option<&str>) -> std::path::PathBuf {
    let p = path.trim();
    match (home, p) {
        (Some(h), "~") => std::path::PathBuf::from(h),
        (Some(h), _) if p.starts_with("~/") => std::path::Path::new(h).join(&p[2..]),
        _ => std::path::PathBuf::from(p),
    }
}

/// Result of checking a private key file before it is used. (key-status-v1)
#[derive(Serialize)]
pub struct KeyStatus {
    /// The path exists and is a regular file.
    pub exists: bool,
    /// The file could be opened for reading by this process.
    pub readable: bool,
    /// The key is protected by a passphrase (needs one to be used).
    pub encrypted: bool,
    /// Plain-language problem, when the key cannot be used as-is.
    pub error: Option<String>,
}

/// Check a private key path: exists, readable, passphrase-protected. The key is
/// parsed locally with the same loader the SSH login uses (nothing leaves this
/// process, and no key material is returned) - only the verdict is reported.
#[tauri::command]
pub fn ssh_key_status(path: String) -> KeyStatus {
    let expanded = expand_tilde(&path);
    let p = expanded.as_path();
    let path = if expanded.to_string_lossy() == path.trim() { path } else { format!("{} ({})", path.trim(), expanded.display()) };
    if path.trim().is_empty() {
        return KeyStatus { exists: false, readable: false, encrypted: false, error: Some("No SSH key path given.".into()) };
    }
    if !p.is_file() {
        return KeyStatus { exists: false, readable: false, encrypted: false, error: Some(format!("SSH key file not found: {path}")) };
    }
    if let Err(e) = std::fs::File::open(p) {
        return KeyStatus { exists: true, readable: false, encrypted: false, error: Some(format!("SSH key file {path} cannot be read ({e}). Check its owner and permissions.")) };
    }
    match russh::keys::load_secret_key(p, None) {
        Ok(_) => KeyStatus { exists: true, readable: true, encrypted: false, error: None },
        Err(russh::keys::Error::KeyIsEncrypted) => KeyStatus { exists: true, readable: true, encrypted: true, error: None },
        Err(e) => KeyStatus { exists: true, readable: true, encrypted: false, error: Some(format!("{path} is not a usable SSH private key ({e}).")) },
    }
}

#[cfg(test)]
mod tests {
    use super::{expand_tilde_with, ssh_key_status};

    #[test]
    fn tilde_expansion() {
        let h = Some("/home/op");
        assert_eq!(expand_tilde_with("~/.ssh/pt_dbsync", h), std::path::PathBuf::from("/home/op/.ssh/pt_dbsync"));
        assert_eq!(expand_tilde_with("  ~/.ssh/k ", h), std::path::PathBuf::from("/home/op/.ssh/k"));
        assert_eq!(expand_tilde_with("~", h), std::path::PathBuf::from("/home/op"));
        assert_eq!(expand_tilde_with("/abs/key", h), std::path::PathBuf::from("/abs/key"));
        assert_eq!(expand_tilde_with("~other/key", h), std::path::PathBuf::from("~other/key"));
        assert_eq!(expand_tilde_with("~/.ssh/k", None), std::path::PathBuf::from("~/.ssh/k"));
    }
    use std::process::Command;

    fn tmpdir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pt-keystatus-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn keygen(path: &std::path::Path, pass: &str) {
        let ok = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", pass, "-f"])
            .arg(path)
            .status()
            .expect("ssh-keygen");
        assert!(ok.success());
    }

    #[test]
    fn key_status_cases() {
        let d = tmpdir();
        let missing = d.join("missing");
        let st = ssh_key_status(missing.to_string_lossy().into());
        assert!(!st.exists && st.error.unwrap().contains("not found"));

        let plain = d.join("plain");
        keygen(&plain, "");
        let st = ssh_key_status(plain.to_string_lossy().into());
        assert!(st.exists && st.readable && !st.encrypted && st.error.is_none());

        let enc = d.join("enc");
        keygen(&enc, "correct horse");
        let st = ssh_key_status(enc.to_string_lossy().into());
        assert!(st.exists && st.readable && st.encrypted && st.error.is_none());

        let junk = d.join("junk");
        std::fs::write(&junk, "not a key").unwrap();
        let st = ssh_key_status(junk.to_string_lossy().into());
        assert!(st.exists && st.readable && st.error.unwrap().contains("not a usable SSH private key"));

        use std::os::unix::fs::PermissionsExt;
        let noread = d.join("noread");
        keygen(&noread, "");
        std::fs::set_permissions(&noread, std::fs::Permissions::from_mode(0o000)).unwrap();
        let st = ssh_key_status(noread.to_string_lossy().into());
        assert!(st.exists && !st.readable && st.error.unwrap().contains("cannot be read"));

        let st = ssh_key_status("  ".into());
        assert!(!st.exists && st.error.is_some());
        std::fs::set_permissions(&noread, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::remove_dir_all(&d).unwrap();
    }
}
