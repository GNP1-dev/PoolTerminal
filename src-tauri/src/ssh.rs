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

/// SSH client event handler.
struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // SECURITY (Phase 0): accept any host key, but log its fingerprint.
        // Pre-release requirement: trust-on-first-use / known_hosts verification
        // so the operator is warned if their BP host key ever changes.
        // Tracked in HANDOVER "known carry-over issues".
        let fp = server_public_key.fingerprint(ssh_key::HashAlg::Sha256);
        eprintln!("[ssh] accepting server host key (UNVERIFIED): {fp}");
        Ok(true)
    }
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
        let handle = client::connect(config, (host, port), ClientHandler).await?;
        Ok(handle)
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
    let mut guard = state.0.lock().await;
    let session = guard.as_mut().ok_or_else(|| "not connected".to_string())?;
    session.run(&command).await.map_err(|e| e.to_string())
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
