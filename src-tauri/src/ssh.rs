//! PoolTerminal — async SSH layer (russh 0.61).
//!
//! Design notes:
//! - Async-native via `russh`. NO `std::sync::Mutex` held across `.await`
//!   (that was the `ssh2` bug that froze old PoolManager's UI). State uses
//!   `tokio::sync::Mutex`, locked briefly per command, which also serialises
//!   commands onto the single session — exactly what our read-only polling wants.
//! - READ-ONLY by design. This layer runs commands and returns their output;
//!   it never writes to or controls the node.
//! - Three auth methods: public-key, password, and keyboard-interactive (for
//!   2FA / Google Authenticator BPs). Keyboard-interactive supports a declared
//!   credential ordering, matching old PoolManager's dropdown.
//!
//! HARDFORK: era-sensitive query commands will be layered on top of `ssh_run`.

use std::collections::VecDeque;
use std::sync::Arc;

use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use tokio::sync::Mutex;

/// Recorded when a presented host key does not match the stored one, so `open()`
/// can turn russh's generic abort into a descriptive, actionable error. (tofu-v72)
enum HostKeyReport {
    Mismatch { stored: String, presented: String },
}

/// SSH client event handler with trust-on-first-use host-key verification. (tofu-v72)
struct ClientHandler {
    host_id: String,
    report: Arc<std::sync::Mutex<Option<HostKeyReport>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Trust-on-first-use: store the fingerprint on first connect, accept it on
        // later connects only if it matches, and hard-block on mismatch (possible
        // MITM or rebuilt host). ssh_forget_host clears a stored key to trust a new
        // one after an explicit operator warning. (tofu-v72)
        let fp = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();
        match known_hosts_lookup(&self.host_id) {
            None => {
                let _ = known_hosts_store(&self.host_id, &fp);
                eprintln!("[ssh] TOFU first connect to {} - stored host key {}", self.host_id, fp);
                Ok(true)
            }
            Some(stored) if stored == fp => Ok(true),
            Some(stored) => {
                eprintln!(
                    "[ssh] HOST KEY MISMATCH for {} - stored {} presented {} - BLOCKED",
                    self.host_id, stored, fp
                );
                if let Ok(mut r) = self.report.lock() {
                    *r = Some(HostKeyReport::Mismatch { stored, presented: fp });
                }
                Ok(false)
            }
        }
    }
}

/// Path to the app known-hosts file (lines: `host:port  SHA256fingerprint`). (tofu-v72)
fn known_hosts_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::Path::new(&home)
        .join(".local/share/com.gnp1.poolterminal")
        .join("known_hosts")
}

fn known_hosts_lookup(host_id: &str) -> Option<String> {
    let content = std::fs::read_to_string(known_hosts_path()).ok()?;
    for line in content.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(h), Some(fp)) = (parts.next(), parts.next()) {
            if h == host_id {
                return Some(fp.to_string());
            }
        }
    }
    None
}

fn known_hosts_store(host_id: &str, fp: &str) -> std::io::Result<()> {
    let path = known_hosts_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(f, "{host_id} {fp}")
}

fn known_hosts_forget(host_id: &str) -> std::io::Result<()> {
    let path = known_hosts_path();
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let kept: Vec<&str> = content
        .lines()
        .filter(|l| l.split_whitespace().next() != Some(host_id))
        .collect();
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    std::fs::write(&path, out)
}

/// Clear a saved host key so the next connection re-trusts it (TOFU). Called after
/// the operator confirms a legitimate host rebuild. (tofu-v72)
#[tauri::command]
pub async fn ssh_forget_host(host: String, port: u16) -> Result<(), String> {
    known_hosts_forget(&format!("{host}:{port}")).map_err(|e| e.to_string())
}

/// Credential ordering for keyboard-interactive 2FA. Different nodes prompt in
/// different orders depending on their PAM stack; the operator declares which.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum AuthOrder {
    /// 2FA code first, then password.
    CodeThenPassword,
    /// Password first, then 2FA code.
    PasswordThenCode,
    /// Password only (no 2FA prompt).
    PasswordOnly,
}

/// A live SSH session to the block producer node.
pub struct SshSession {
    handle: Handle<ClientHandler>,
}

impl SshSession {
    async fn open(host: &str, port: u16) -> anyhow::Result<Handle<ClientHandler>> {
        // Config::default() leaves inactivity_timeout unset (connection stays
        // open), which suits a persistent polling connection. Keepalive tuning
        // comes when we build the Phase 1 poll loop.
        let config = Arc::new(client::Config::default());
        let host_id = format!("{host}:{port}");
        let report = Arc::new(std::sync::Mutex::new(None));
        let handler = ClientHandler { host_id: host_id.clone(), report: report.clone() };
        match client::connect(config, (host, port), handler).await {
            Ok(handle) => Ok(handle),
            Err(e) => {
                // Turn a host-key mismatch abort into a clear, actionable error. (tofu-v72)
                let mismatch = report.lock().ok().and_then(|mut r| r.take());
                if let Some(HostKeyReport::Mismatch { stored, presented }) = mismatch {
                    anyhow::bail!(
                        "SSH host key mismatch for {host_id}: stored {stored} but server presented {presented}. \
                         Connection BLOCKED - this can mean the host was rebuilt, or a possible man-in-the-middle. \
                         If you deliberately rebuilt this machine, clear its saved key to trust the new one."
                    );
                }
                Err(e.into())
            }
        }
    }

    /// Connect using public-key authentication.
    pub async fn connect_key(
        host: &str,
        port: u16,
        username: &str,
        key_path: &str,
        passphrase: Option<&str>,
    ) -> anyhow::Result<Self> {
        let mut handle = Self::open(host, port).await?;
        let key = load_secret_key(key_path, passphrase)?;
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        let res = handle
            .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await?;
        if !res.success() {
            anyhow::bail!("public-key authentication failed");
        }
        Ok(Self { handle })
    }

    /// Connect using simple password authentication (no 2FA).
    pub async fn connect_password(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
    ) -> anyhow::Result<Self> {
        let mut handle = Self::open(host, port).await?;
        let res = handle.authenticate_password(username, password).await?;
        if !res.success() {
            anyhow::bail!("password authentication failed");
        }
        Ok(Self { handle })
    }

    /// Connect using the local ssh-agent (keys loaded via `ssh-add`).
    ///
    /// This is how most cloud SPOs authenticate: the private key lives in the
    /// agent (often passphrase-protected and unlocked once per session), not as
    /// a readable file. We ask the agent for its identities and try each against
    /// the server until one is accepted — exactly what OpenSSH does.
    pub async fn connect_agent(host: &str, port: u16, username: &str) -> anyhow::Result<Self> {
        let mut handle = Self::open(host, port).await?;

        let mut agent = russh::keys::agent::client::AgentClient::connect_env()
            .await
            .map_err(|e| anyhow::anyhow!(
                "could not reach the SSH agent ({e}). Is ssh-agent running and SSH_AUTH_SOCK set?"
            ))?;

        let identities = agent
            .request_identities()
            .await
            .map_err(|e| anyhow::anyhow!("could not list agent identities: {e}"))?;

        if identities.is_empty() {
            anyhow::bail!("the SSH agent has no keys loaded (run `ssh-add` to add your key)");
        }

        // Try each identity; the server accepts the one that's authorised.
        // AgentClient implements Signer, so we pass &mut agent as the signer —
        // the private key never leaves the agent (it signs the challenge). The
        // identity wraps a key or cert; public_key() gives us the PublicKey.
        for id in identities {
            let pubkey = id.public_key().into_owned();
            match handle
                .authenticate_publickey_with(username, pubkey, None, &mut agent)
                .await
            {
                Ok(r) if r.success() => return Ok(Self { handle }),
                Ok(_) => continue,                 // this key not accepted; try next
                Err(e) => {
                    // Signer/agent error — surface it but keep trying others.
                    eprintln!("[ssh] agent auth attempt error: {e}");
                    continue;
                }
            }
        }
        anyhow::bail!("ssh-agent authentication failed — no key in the agent was accepted by the server");
    }

    /// Connect using keyboard-interactive authentication (password + 2FA code).
    ///
    /// Credentials are fed in the declared `order` as the server's prompts
    /// arrive. This handles both one-prompt-per-request PAM stacks (the common
    /// case: code request, then password request) and batched multi-prompt
    /// requests, by popping one queued credential per prompt.
    ///
    /// Note: a 2FA code is time-limited and single-use, so this establishes the
    /// connection once with a fresh code. Reconnects require a fresh code.
    pub async fn connect_keyboard_interactive(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        code: &str,
        order: AuthOrder,
    ) -> anyhow::Result<Self> {
        let mut handle = Self::open(host, port).await?;

        let mut queue: VecDeque<String> = match order {
            AuthOrder::CodeThenPassword => {
                VecDeque::from(vec![code.to_string(), password.to_string()])
            }
            AuthOrder::PasswordThenCode => {
                VecDeque::from(vec![password.to_string(), code.to_string()])
            }
            AuthOrder::PasswordOnly => VecDeque::from(vec![password.to_string()]),
        };

        let mut res = handle
            .authenticate_keyboard_interactive_start(username, None::<String>)
            .await?;

        loop {
            match res {
                KeyboardInteractiveAuthResponse::Success => return Ok(Self { handle }),
                KeyboardInteractiveAuthResponse::Failure { .. } => {
                    anyhow::bail!("keyboard-interactive authentication failed");
                }
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    // One queued credential per prompt, in declared order.
                    let mut responses = Vec::with_capacity(prompts.len());
                    for _ in &prompts {
                        responses.push(queue.pop_front().unwrap_or_default());
                    }
                    res = handle
                        .authenticate_keyboard_interactive_respond(responses)
                        .await?;
                }
            }
        }
    }

    /// Run a command, capturing stdout, stderr, and the exit code.
    pub async fn run(&mut self, command: &str) -> anyhow::Result<CommandResult> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut exit_code: i32 = -1; // -1 = no exit status received (abnormal)

        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, ext } => {
                    if ext == 1 {
                        stderr.extend_from_slice(data);
                    } else {
                        stdout.extend_from_slice(data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status as i32,
                _ => {}
            }
        }

        Ok(CommandResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
        })
    }

    pub async fn disconnect(&mut self) -> anyhow::Result<()> {
        self.handle
            .disconnect(Disconnect::ByApplication, "", "English")
            .await?;
        Ok(())
    }
}

// ============================================================
// Tauri-facing state, types, and commands
// ============================================================

/// Managed Tauri state: the (optional) live session behind an async mutex.
pub struct SshState(pub Arc<Mutex<Option<SshSession>>>);

impl Default for SshState {
    fn default() -> Self {
        SshState(Arc::new(Mutex::new(None)))
    }
}

#[derive(serde::Deserialize)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
}

/// Tagged enum. JS sends one of:
///   { type: "key", path, passphrase }
///   { type: "password", password }
///   { type: "keyboard_interactive", password, code, order }
///   { type: "agent" }
/// where order is "code_then_password" | "password_then_code" | "password_only".
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthMethod {
    Key {
        path: String,
        passphrase: Option<String>,
    },
    Password {
        password: String,
    },
    KeyboardInteractive {
        password: String,
        code: String,
        order: AuthOrder,
    },
    Agent,
}

#[derive(serde::Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[tauri::command]
pub async fn ssh_connect(
    state: tauri::State<'_, SshState>,
    params: ConnectParams,
) -> Result<bool, String> {
    let session = match params.auth {
        AuthMethod::Key { path, passphrase } => {
            SshSession::connect_key(
                &params.host,
                params.port,
                &params.username,
                &path,
                passphrase.as_deref(),
            )
            .await
        }
        AuthMethod::Password { password } => {
            SshSession::connect_password(&params.host, params.port, &params.username, &password)
                .await
        }
        AuthMethod::KeyboardInteractive {
            password,
            code,
            order,
        } => {
            SshSession::connect_keyboard_interactive(
                &params.host,
                params.port,
                &params.username,
                &password,
                &code,
                order,
            )
            .await
        }
        AuthMethod::Agent => {
            SshSession::connect_agent(&params.host, params.port, &params.username).await
        }
    }
    .map_err(|e| e.to_string())?;

    *state.0.lock().await = Some(session);
    Ok(true)
}

#[tauri::command]
pub async fn ssh_run(
    state: tauri::State<'_, SshState>,
    command: String,
) -> Result<CommandResult, String> {
    // Open the channel under a brief lock, then release the lock before exec and
    // the (possibly long) read, so commands run concurrently on independent
    // channels. A slow query (leadership-schedule, up to 2 min) no longer blocks
    // fast ones like mempool/tip. The channel owns its own stream and is
    // independent of the session lock (same pattern as the db-sync tunnel).
    // (concurrent-channels-v90)
    let mut channel = {
        let mut guard = state.0.lock().await;
        let session = guard.as_mut().ok_or_else(|| "not connected".to_string())?;
        session
            .handle
            .channel_open_session()
            .await
            .map_err(|e| e.to_string())?
    };
    channel.exec(true, &*command).await.map_err(|e| e.to_string())?;   // &str for Into<Vec<u8>> /*v90-exec-deref*/

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: i32 = -1;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, ext } => {
                if ext == 1 {
                    stderr.extend_from_slice(data);
                } else {
                    stdout.extend_from_slice(data);
                }
            }
            ChannelMsg::ExitStatus { exit_status } => exit_code = exit_status as i32,
            _ => {}
        }
    }
    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
    })
}

#[tauri::command]
pub async fn ssh_disconnect(state: tauri::State<'_, SshState>) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().await.take() {
        session.disconnect().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_is_connected(state: tauri::State<'_, SshState>) -> Result<bool, String> {
    Ok(state.0.lock().await.is_some())
}
// ===========================================================================
// SSH tunnel support (additive) - appended for PoolTerminal SSH-tunnelled
// Postgres. Opens a direct-tcpip channel (the SSH local-forward primitive) so a
// db-sync that only listens on the remote machine's localhost can be reached.
// This impl block is separate and touches nothing above; safe to append.
// ===========================================================================
impl SshSession {
    /// Open a direct-tcpip channel to `host:port` as resolved on the SSH server
    /// side (typically 127.0.0.1:5432 - the remote db-sync). The returned channel
    /// owns its own stream and is independent of the session lock, so the caller
    /// can release the SshState guard before running a (potentially long) query.
    pub async fn open_forward(
        &self,
        host: &str,
        port: u16,
    ) -> anyhow::Result<russh::Channel<russh::client::Msg>> {
        let ch = self
            .handle
            .channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1".to_string(), 0)
            .await?;
        Ok(ch)
    }
}


// ===========================================================================
// Relay monitoring: independent SSH sessions, keyed by relay id.
//
// Held in a SEPARATE managed state (RelaySshState) from the primary SshState so
// the BP connection is never touched. Each relay tab owns one entry in the map
// (e.g. "relay1", "relay2") and runs read-only Prometheus scrapes over it. The
// auth path reuses the same SshSession::connect_* methods as the primary.
// Safe: this block adds new items only and changes nothing above.
// ===========================================================================

/// Shared connect dispatch, reused by the relay connect command. Mirrors the
/// match in `ssh_connect` exactly (the primary path is left untouched).
async fn connect_session(params: ConnectParams) -> anyhow::Result<SshSession> {
    match params.auth {
        AuthMethod::Key { path, passphrase } => {
            SshSession::connect_key(
                &params.host,
                params.port,
                &params.username,
                &path,
                passphrase.as_deref(),
            )
            .await
        }
        AuthMethod::Password { password } => {
            SshSession::connect_password(&params.host, params.port, &params.username, &password)
                .await
        }
        AuthMethod::KeyboardInteractive {
            password,
            code,
            order,
        } => {
            SshSession::connect_keyboard_interactive(
                &params.host,
                params.port,
                &params.username,
                &password,
                &code,
                order,
            )
            .await
        }
        AuthMethod::Agent => {
            SshSession::connect_agent(&params.host, params.port, &params.username).await
        }
    }
}

/// Managed Tauri state: independent relay sessions keyed by relay id, held
/// alongside (never replacing) the primary SshState.
pub struct RelaySshState(pub Arc<Mutex<std::collections::HashMap<String, SshSession>>>);

impl Default for RelaySshState {
    fn default() -> Self {
        RelaySshState(Arc::new(Mutex::new(std::collections::HashMap::new())))
    }
}

#[tauri::command]
pub async fn relay_ssh_connect(
    state: tauri::State<'_, RelaySshState>,
    id: String,
    params: ConnectParams,
) -> Result<bool, String> {
    let session = connect_session(params).await.map_err(|e| e.to_string())?;
    state.0.lock().await.insert(id, session);
    Ok(true)
}

#[tauri::command]
pub async fn relay_ssh_run(
    state: tauri::State<'_, RelaySshState>,
    id: String,
    command: String,
) -> Result<CommandResult, String> {
    let mut guard = state.0.lock().await;
    let session = guard
        .get_mut(&id)
        .ok_or_else(|| format!("relay '{id}' not connected"))?;
    session.run(&command).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn relay_ssh_disconnect(
    state: tauri::State<'_, RelaySshState>,
    id: String,
) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().await.remove(&id) {
        session.disconnect().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn relay_ssh_is_connected(
    state: tauri::State<'_, RelaySshState>,
    id: String,
) -> Result<bool, String> {
    Ok(state.0.lock().await.contains_key(&id))
}
