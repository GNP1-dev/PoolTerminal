# PoolTerminal - AI-Assisted Code Review Summary

*AI-assisted review of the source, carried out at the request of the project author. Latest pass: 8 July 2026.*

> **This was not an independent security audit.**
> This document is the summary of a code review performed by an AI language model, prompted and directed by the project author. No third party, security firm, or human reviewer outside the project was involved. It has not been certified, validated, or signed off by anyone. It is published because a record of what was looked at is more useful than no record at all, not as an assurance that the software is secure.
>
> **If you intend to run PoolTerminal against your own block producer, you are responsible for reviewing the source yourself, or having someone qualified review it on your behalf.** The software is provided as-is under the Apache 2.0 licence, with no warranty of any kind.

> **Editorial note (added after this pass was written).** The two items listed under "Outstanding before public release" below - the missing `LICENSE` file (A) and the hardcoded pool identifier (B) - were both resolved in commit `8ac69db`. All five security findings were already addressed at the time of the pass. The text below is preserved as originally written.

## What this review was, and what it was not

**What it was.** An AI language model was given the full `src/` frontend (49 JS modules) and the `src-tauri/src/` Rust backend to read, and was asked to look for security problems, with priority on five areas chosen by the author: SSH host-key verification, API-token handling, the db-sync SSH tunnel and loopback-trust model, cross-site-scripting exposure through untrusted on-chain data, and secrets at rest. The findings below are what that reading produced, and the fixes described were made by the author in response.

**What it was not.** In particular, this exercise did **not** include any of the following:

- No independent or third-party involvement of any kind.
- No human security professional reviewed the code or checked the AI's conclusions.
- No penetration testing, fuzzing, or dynamic analysis. Nothing was executed or attacked; the code was read, not run.
- No dependency or supply-chain audit of the Rust crates or JS packages the project pulls in.
- No cryptographic review.
- No review of the build, release, or signing pipeline, and no verification that a published binary corresponds to this source.
- No formal methodology, no CVSS scoring, no reproducible test cases.

An AI reading source code can miss vulnerabilities, misread control flow, and state incorrect conclusions with complete confidence. Treat everything below as one reader's notes, not as verification.

## Your responsibility as a user

PoolTerminal connects over SSH to a block producer, which is a high-value machine. Nothing in this document reduces your own obligation to satisfy yourself that the code is safe to run in your environment. Read the source, check the SSH and credential handling against your own threat model, run it against a test node first, and give the SSH user and any database role the narrowest permissions that work. If you are not in a position to do that review yourself, do not assume this document has done it for you.

## Scope of the pass

PoolTerminal is a Tauri 2 desktop application (Rust backend, vanilla-JS frontend) providing a read-only operational dashboard for Cardano stake pool operators. It connects to the operator's own block-producer and relay nodes over SSH, and optionally enriches from the operator's own db-sync Postgres, the Koios public API, and Blockfrost. It performs no transaction signing, holds no key material, and exercises no node control from the GUI.

The pass covered the full `src/` frontend and the `src-tauri/src/` Rust backend, prioritising the five areas listed above.

This pass predates the Alerts / Telegram feature added in v0.2.0. That feature
was not read and is not covered by anything in this document.

## Outcome of the pass

All five priority findings raised in the earlier pass were read as addressed in the source as it stood on the review date. Two non-security items remained outstanding at that point; both were release hygiene rather than vulnerabilities, and both have since been resolved (see the editorial note above).

This is a statement about what the source appeared to do when read. It is not a certification, and it does not mean the application is free of security defects.

## Findings addressed

**1. Cross-site scripting via third-party pool metadata.** The delegator "journey" view previously interpolated another pool's self-declared on-chain metadata (ticker and name) into the DOM without escaping. Because the Tauri webview can reach the SSH command bridge, this was a path from arbitrary chain data toward command execution on the block producer. Both fields are now HTML-escaped at the point of render, and a Content-Security-Policy (`default-src 'self'; script-src 'self'`) has been added as a defence-in-depth backstop so a future miss cannot reach script execution. A sweep of `innerHTML` sinks found no remaining unescaped externally-sourced values, though a read-only sweep cannot guarantee completeness.

**2. SSH host-key verification.** Host-key checking previously accepted any key unconditionally, leaving the connection exposed to machine-in-the-middle interception. The application now implements trust-on-first-use: the host key fingerprint is recorded on first connection, accepted on later connections only when it matches, and connection is hard-blocked on any mismatch, with an explicit operator-facing report. A dedicated path allows an operator to forget a stored key after a legitimate host rebuild.

**3. Secrets at rest.** The SSH private-key passphrase is no longer persisted under any circumstances; operators are directed to ssh-agent or per-session re-entry. Relay connection settings persist only non-secret fields (host, port, username, transport, method, key path). The optional db-sync password remains stored only when the operator explicitly opts in, and the loopback-trust configuration path removes the need to store a password at all.

**4. API-token handling.** Koios API calls, including the authenticated Bearer token, were previously assembled as shell commands executed over SSH on the node, which exposed the token in the node's process table on every call. Koios traffic now issues directly from the host machine as native HTTPS requests, with the token attached as a real HTTP header. This removes the token from the node's process arguments, takes the public-API load off the block producer, and eliminates the associated shell-quoting risks.

**5. db-sync SSH tunnel and loopback-trust model.** The tunnelled-Postgres design reads as sound: the connection is presented to Postgres as arriving on the remote host's loopback interface, so a loopback-trust authentication line is satisfied without a stored password. Key-based SSH authentication appeared to be handled correctly and key contents are not read by the key-discovery routine. This model rests on host-key verification (finding 2), which it previously did not.

Operators are advised to point the db-sync tunnel at a role with read-only (SELECT) grants as defence in depth, and to note that a `127.0.0.1/32 trust` line grants database access to any local process on the db-sync host - appropriate for a single-operator machine, but worth understanding before it is applied on a shared one.

## Items outstanding at the time of the pass

**A. License file is missing.** The project documentation states an Apache 2.0 licence and references a `LICENSE` file, but that file was not present in the tree. Until added, the repository would be all-rights-reserved by default and the stated licence would not take effect. *(Resolved in `8ac69db`.)*

**B. A pool identifier is hardcoded.** The delegator journey view identified "your pool" from a hardcoded pool ID constant. For the original operator this behaves correctly, but any other operator cloning the repository would see that same pool highlighted as theirs. The value is public information and not a secret, but it should be derived from the connected pool rather than fixed in source. *(Resolved in `8ac69db`.)*

## Non-blocking notes

The connection screen prefills an example host address and username taken from the original development environment; generic placeholders would read better for a general audience, though these are user-overwritable defaults and carry no risk. The project has no automated test coverage; the data layer - the capability-resolution rules, the read-model calculations, and the input-validation guards - is well shaped for it and is the highest-value place to begin. `read-model.js` contains several near-duplicate backfill routines that would benefit from a shared factory. None of these are security issues.

## Reporting a security problem

If you find a security issue in PoolTerminal, please report it through the repository's issue tracker or the contact route given in the project README, rather than assuming this document means it has already been considered.

---

*This summary reflects one AI-assisted reading of the source on the date above. It is not an audit, not a certification, and not a substitute for your own review. Anyone choosing to run this application is responsible for reviewing the code themselves.*
