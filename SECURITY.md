# Security Policy

PoolTerminal is a read-only operational dashboard for Cardano stake pool
operators. It performs no transaction signing, holds no key material, and
exercises no node control from the GUI. Even so, it connects to your block
producer over SSH, so its security matters — and the project's trust model is
simple: **audit the code before you trust it.**

## Independent review

PoolTerminal has been through independent code and security review. The latest
summary is published here:

- [`docs/security/security-review-2026-07-08.md`](docs/security/security-review-2026-07-08.md)

All security findings from that review have been resolved in the current source.
The summary is provided for transparency; you are still encouraged to audit the
code yourself.

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
third-party services (Koios, Blockfrost) — those are operated and secured by you
or their respective providers, consistent with the project's trust model.
