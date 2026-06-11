# PoolTerminal

**A Bloomberg-terminal-style desktop dashboard for Cardano stake pool operators.**

Dense. Real-time. Read-only. Packed with data nothing else surfaces.

---

> ⚠️ **Early development.** Not yet released. Star to follow progress.

> _Last updated: 11 June 2026_

## What it is

PoolTerminal is a desktop application for SPOs running their own Cardano block producer. It connects to your node — over SSH, or directly when run on the node itself — and presents a rich, real-time operational dashboard that goes far beyond what gLiveView or generic chain explorers offer.

It is **read-only by design** — no transaction signing, no key access, no node control from the GUI. Your keys never leave your node. PoolTerminal observes and reports; it does not act.

## Why

Running a Cardano stake pool produces a torrent of operational data that's locked away in log files, sqlite databases, Prometheus endpoints, cardano-cli outputs and external APIs. Existing tools surface a fraction of it. PoolTerminal pulls it all together in one place, visualises it properly, and stores history locally so you can see trends over weeks and months — not just snapshots.

## Features

Working today:

- **NOW** — Live current-epoch dashboard: chain pulse, tip/sync, KES expiry, ideal/leader, era badge, mempool, peer counts, and a compact relay map. **Upcoming blocks** lists your assigned leader slots for the current *and* next epoch (once the ~36 h leadership-schedule window opens), each with a live countdown — sourced from the authoritative `cardano-cli` leadership schedule and cached per epoch.
- **HISTORY** — Full per-epoch table back to your pool's first epoch: blocks, ideal, luck, delegators, active stake, and a colour-coded six-way reward split (delegator reward · pledge · min-fee · margin · **SPO earnings** · total payout), where SPO earnings is the operator's own take per epoch. Charts for blocks-per-epoch and luck. Two interchangeable data sources (see below).
- **DELEGATORS** — One data-rich, sortable table of every delegator, merging live stake with a computed **loyalty** ranking (tenure × stake-weight × penalties for defection/withdrawal). Sort by loyalty or stake, dust filter, paginated. Click any delegator for a deep-dive: balance, rewards, withdrawals, DRep flag, and a colourful **pool-movement journey** showing every pool they've delegated to with entry/exit epochs and active stake at each. db-sync powered (no rate limits); loyalty cached per epoch.
- **NODE HEALTH** — Host and node-process metrics (CPU, memory, peers, resources) with historical samples.
- **MAP** — Full-size D3 world map (Natural Earth, cached offline after first load) plotting your node and its live peers, geo-located, with RTT-coloured connections and a side panel of latency bands and geographic distribution.
- **DEMO MODE** — Built-in synthetic pool data so you can try the full UI without connecting to a real node.

Placeholder tabs, planned next: **NOTIFICATIONS** (live stake-change feed), **REWARDS**, **GOVERNANCE** (DRep).

## Data sources

History can be served from either of two interchangeable sources, behind one selector:

- **db-sync** — reads a local (or remote) Cardano db-sync Postgres directly. Complete, gap-free, no rate limits. Best for operators who already run db-sync.
- **Koios** — the no-infrastructure fallback. The entire backfill is **two bulk API calls** (`pool_history` + `epoch_info`), rate-limit-safe by design. Ideal is computed locally from real network stake and block counts; SPO pledge is derived so totals reconcile with PoolTool.

Both produce the same canonical per-epoch data, so the rest of the app is source-agnostic. db-sync is the fuller source (Koios's `pool_history` occasionally omits reward fields for some epochs — PoolTerminal shows `—` there rather than inventing numbers). A temporary in-app toggle switches between them for testing; a setup wizard will make this a guided choice.

## Connecting

- **Remote node (SSH)** — connect to your BP or relay over SSH. Supports password, password + 2FA (keyboard-interactive), SSH key files (auto-detected or custom path, encrypted keys via passphrase), and ssh-agent.
- **This machine (local)** — run PoolTerminal *on* the node itself; it executes commands directly, no SSH needed.

Relays are supported and degrade gracefully — block-producer-only panels (KES, ideal, leader, upcoming blocks) are clearly marked and skipped, so a relay connects cleanly without waiting on data it can't have.

## Requirements

- Linux desktop (Ubuntu 22.04+, Debian 12+, Fedora 40+, or any modern distro with WebKitGTK 4.1)
- Access to your Cardano node — SSH to a remote node, or PoolTerminal running on the node
- A running Cardano node with the standard Guild Operators tooling layout
- (Optional) `cncli` on the node — some features unlock with cncli data
- (Optional) **db-sync** for gap-free history — not required; Koios is the built-in fallback

## Platform support

Linux is the only supported platform. The vast majority of SPOs run Linux desktops or have Linux VMs. macOS and Windows builds would require code signing fees and platform-specific testing that the project can't currently justify. Contributions welcome if anyone wants to port.

## Installation

> 🚧 Not yet available. First release expected Q3 2026.

When the first release lands, you'll be able to download:
- `.AppImage` — universal Linux binary, no install needed
- `.deb` — for Debian/Ubuntu

## Build from source

> 🚧 Will be documented once the build is stabilised. Development run:

```bash
npm install
cargo tauri dev
```

## Trust & security

PoolTerminal is open source, Apache 2.0 licensed. Audit before you trust it. Key trust properties:

- **Read-only.** No commands that modify state on your node are issued.
- **Keys never leave the node.** PoolTerminal does not transmit keys, mnemonics, or wallet files anywhere.
- **Secrets are never persisted.** SSH passwords, OTP codes, and key passphrases live only in memory for the session — never written to disk.
- **No telemetry.** PoolTerminal does not phone home. Network connections are: your node (SSH), your db-sync (if used), and read-only public APIs (Koios for pool stats, ip-api for peer geo-location). Nothing else.
- **Local cache only.** Historical data is stored in a SQLite database on your own machine.

## Tech stack

- **Tauri 2** (Rust + web frontend, native performance)
- **Vanilla JS** frontend (no framework)
- **D3 + Apache ECharts** for visualisations
- **russh** for async SSH; **tokio-postgres** for db-sync; **rusqlite** for the local cache

## Hard fork awareness

PoolTerminal is built with Cardano's regular hard fork cycle in mind. See `HARDFORK.md` for the running list of fork-sensitive code areas and the current upgrade target.

## Documentation

- `MANUAL.md` — operator's manual: setup, views, data sources, caching, troubleshooting.
- `DESIGN.md` — architecture and design notes.
- `HARDFORK.md` — fork-sensitive code and upgrade checklist.

## Status

Active development. Core data layer (both sources), connection (SSH + local), and the NOW / HISTORY / DELEGATORS / NODE HEALTH / MAP views are working. Next: NOTIFICATIONS (live stake-change feed), setup wizard, REWARDS / GOVERNANCE views.

## Contributing

Contributions welcome once the foundation is in place. For now, watch and star — feedback on the design is genuinely useful.

## Licence

Apache 2.0 — see `LICENSE`.

## Author

Built by [GNP1-dev](https://github.com/GNP1-dev) — operator of the [GNP1 (GrahamsNumberPlus1)](https://grahamsnumberplus1.com/) Cardano stake pool.

If PoolTerminal helps you operate your pool better, the most generous thing you can do in return is delegate to a pool that donates to charity — GNP1 donates to mental health causes, but plenty of other charity pools exist too.
