# Security Policy

PoolTerminal is a read-only operational dashboard for Cardano stake pool
operators. It performs no transaction signing, holds no key material, and
exercises no node control from the GUI. Even so, it connects to your block
producer over SSH, so its security matters - and the project's trust model is
simple: **audit the code before you trust it.**

## Code review

PoolTerminal has had an AI-assisted code review. It has not had an independent
or human security audit. No third party, security firm, or reviewer outside the
project has examined this code. A summary of what that review covered, and the
substantial list of what it did not, is published here:

- [docs/security/security-review-2026-07-08.md](docs/security/security-review-2026-07-08.md)

The security findings raised in that review were addressed in the source at the
time it was written. That is a statement about what the code appeared to do when
read by an AI model at the author's direction. It is not verification, and it is
not a certification.

The review predates the Alerts / Telegram feature added in v0.2.0, which is
therefore not covered by it.

**If you intend to run PoolTerminal against your own block producer, you are
responsible for reviewing the source yourself, or having someone qualified do it
on your behalf.** The software is provided as-is under Apache 2.0, with no
warranty of any kind.

## What is stored on disk

PoolTerminal keeps everything on your own machine. Nothing is transmitted to the
author or any third party. Two things are worth stating plainly:

**Never written to disk, in any mode:** SSH passwords, OTP / 2FA codes, and SSH
key passphrases. These live in memory for the session only. They are the
credentials that could reach your node, and PoolTerminal will ask again rather
than store them.

**Written to disk, unencrypted, inside PoolTerminal's application-data directory**
(`~/.local/share/com.gnp1.poolterminal/` on Linux) - because these features
cannot work across restarts otherwise:

| Credential | Stored when | What it can do |
|---|---|---|
| Koios API key | you use the keyed tier | reads public chain data |
| Blockfrost project key | you add one | reads public chain data |
| Telegram bot token | you set up Alerts | controls only the bot you created |
| db-sync password | *only* if you tick "save password" | reads your own local database |

None of these can reach your node, your keys, or your funds. They carry the same
exposure as any other file in your home directory: an attacker who can read them
can already read everything else you own. If you would rather store none of them,
use the free Koios tier, leave Blockfrost and Alerts unconfigured, and use the
`pg_hba.conf` loopback-trust option for db-sync - the application is fully
functional in that configuration.

The Telegram bot token is sent to Telegram as an HTTPS header from the Rust
backend, so it never appears in a command line on your node or in a process list.
In the Alerts UI it is held in a masked field with an explicit show/hide toggle.

## Reporting a vulnerability

If you believe you have found a security issue in PoolTerminal, please **open a
GitHub issue** on this repository describing the problem and how to reproduce it.

When reporting, it helps to include:

- what the issue is and where in the code it lives (file and, if possible, line),
- how to reproduce or trigger it,
- the potential impact as you see it.

## Scope

In scope: the PoolTerminal application code in this repository (the Rust backend
and the JavaScript frontend).

Out of scope: the security of your own node, SSH server, db-sync instance, or
third-party services (Koios, Blockfrost) - those are operated and secured by you
or their respective providers, consistent with the project's trust model.
