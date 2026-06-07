//! PoolTerminal — local command execution (no SSH).
//!
//! The node-transport sibling of `ssh_run`: when PoolTerminal runs ON the node
//! (BP or relay), there's no remote host — cli, Prometheus (curl), cncli and
//! /proc are all local. Forcing ssh-to-localhost would need an SSH server +
//! self-credentials (the anti-pattern we rejected for Postgres), so instead we
//! run the command directly on this machine.
//!
//! Returns the SAME shape as ssh_run ({ stdout, stderr, exit_code }) so the JS
//! `nodeExec` seam treats both transports identically.
//!
//! READ-ONLY by intent, exactly like ssh_run: collectors only ever query.
//! We run via `bash -lc` (login shell) so PATH and the environment resolve the
//! way an interactive operator shell would — important for the Guild env file,
//! cardano-cli on PATH, and sourcing scripts.

use crate::ssh::CommandResult;

#[tauri::command]
pub async fn local_run(command: String) -> Result<CommandResult, String> {
    // Run on a blocking thread — std::process is sync, and some node queries
    // (cli, cncli) can take a moment; don't block the async runtime.
    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new("bash")
            .arg("-lc")
            .arg(&command)
            .output()
    })
    .await
    .map_err(|e| format!("local_run task failed: {e}"))?;

    match result {
        Ok(out) => Ok(CommandResult {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            exit_code: out.status.code().unwrap_or(-1),
        }),
        Err(e) => Err(format!("local_run failed to spawn: {e}")),
    }
}

/// Trivial reachability check for local mode — confirms we can run commands
/// here at all (mirrors the role of ssh_connect's success for remote mode).
#[tauri::command]
pub async fn local_probe() -> Result<bool, String> {
    let r = local_run("echo __LOCAL_OK__".to_string()).await?;
    Ok(r.stdout.contains("__LOCAL_OK__"))
}
