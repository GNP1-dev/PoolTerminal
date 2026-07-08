# PoolTerminal — Security Review Summary

_Independent code and security review. Latest pass: 8 July 2026._

> **Editorial note (added after delivery).** The two items listed under "Outstanding before public release" below — the missing `LICENSE` file (A) and the hardcoded pool identifier (B) — were both resolved in commit `8ac69db`, after this review was delivered. All five security findings were already resolved at the time of review. The text below is preserved as originally written.

## Scope

PoolTerminal is a Tauri 2 desktop application (Rust backend, vanilla-JS frontend) providing a read-only operational dashboard for Cardano stake pool operators. It connects to the operator's own block-producer and relay nodes over SSH, and optionally enriches from the operator's own db-sync Postgres, the Koios public API, and Blockfrost. It performs no transaction signing, holds no key material, and exercises no node control from the GUI.

This review covered the full `src/` frontend (49 JS modules) and the `src-tauri/src/` Rust backend, with priority on five security areas: SSH host-key verification, API-token handling, the db-sync SSH tunnel and loopback-trust model, cross-site-scripting exposure through untrusted on-chain data, and secrets at rest.

## Verdict

All five priority security findings from the initial review have been verified as resolved in the current source. From the standpoint of operator and node safety, the code is in a releasable state. Two non-security items remain outstanding before the repository is suitable to publish as open source; both are release-hygiene rather than vulnerabilities and are listed under "Outstanding" below.

## Resolved findings

**1. Cross-site scripting via third-party pool metadata.** The delegator "journey" view previously interpolated another pool's self-declared on-chain metadata (ticker and name) into the DOM without escaping. Because the Tauri webview can reach the SSH command bridge, this was a path from arbitrary chain data toward command execution on the block producer. Both fields are now HTML-escaped at the point of render, and a Content-Security-Policy (`default-src 'self'; script-src 'self'`) has been added as a defense-in-depth backstop so a future miss cannot reach script execution. A sweep of all `innerHTML` sinks confirmed no remaining unescaped externally-sourced values.

**2. SSH host-key verification.** Host-key checking previously accepted any key unconditionally, leaving the connection exposed to machine-in-the-middle interception. The application now implements trust-on-first-use: the host key fingerprint is recorded on first connection, accepted on later connections only when it matches, and connection is hard-blocked on any mismatch, with an explicit operator-facing report. A dedicated path allows an operator to forget a stored key after a legitimate host rebuild.

**3. Secrets at rest.** The SSH private-key passphrase is no longer persisted under any circumstances; operators are directed to ssh-agent or per-session re-entry. Relay connection settings persist only non-secret fields (host, port, username, transport, method, key path). The optional db-sync password remains stored only when the operator explicitly opts in, and the loopback-trust configuration path removes the need to store a password at all.

**4. API-token handling.** Koios API calls, including the authenticated Bearer token, were previously assembled as shell commands executed over SSH on the node, which exposed the token in the node's process table on every call. Koios traffic now issues directly from the host machine as native HTTPS requests, with the token attached as a real HTTP header. This removes the token from the node's process arguments, takes the public-API load off the block producer entirely, and eliminates the associated shell-quoting risks.

**5. db-sync SSH tunnel and loopback-trust model.** The tunnelled-Postgres design is sound: the connection is presented to Postgres as arriving on the remote host's loopback interface, so a loopback-trust authentication line is satisfied without a stored password. Key-based SSH authentication is handled correctly and key contents are never read by the key-discovery routine. This model now rests on genuine host-key verification (finding 2), which it previously did not.

Operators are advised to point the db-sync tunnel at a role with read-only (SELECT) grants as defense in depth, and to note that a `127.0.0.1/32 trust` line grants database access to any local process on the db-sync host — appropriate for a single-operator machine, but worth understanding before it is applied on a shared one.

## Outstanding before public release

**A. License file is missing.** The project documentation states an Apache 2.0 license and references a `LICENSE` file, but that file is not present in the tree. Until it is added, the repository is technically all-rights-reserved by default and the stated license does not take effect. Adding the standard Apache 2.0 `LICENSE` text is the single blocking item for describing the project as open source.

**B. A pool identifier is hardcoded.** The delegator journey view identifies "your pool" from a hardcoded pool ID constant. For the original operator this behaves correctly, but any other operator who clones the repository would see that same pool highlighted as theirs. The value is public information and not a secret, but it should be derived from the connected pool rather than fixed in source before the tool is used by others.

## Non-blocking notes

The connection screen prefills an example host address and username taken from the original development environment; generic placeholders would read better for a general audience, though these are user-overwritable defaults and carry no risk. The project has no automated test coverage; the data layer — the capability-resolution rules, the read-model calculations, and the input-validation guards — is well shaped for it and is the highest-value place to begin. `read-model.js` contains several near-duplicate backfill routines that would benefit from a shared factory. None of these affect release safety.

---

_This summary reflects the state of the source as reviewed on the date above. Users are encouraged to audit the code themselves before trusting it, consistent with the project's stated trust model._
