# PoolTerminal

**A Bloomberg-terminal-style desktop dashboard for Cardano stake pool operators.**

Dense. Real-time. Read-only. Packed with data nothing else surfaces.

---

> ⚠️ **Early development.** Not yet released. Star to follow progress.

> _Last updated: 23 June 2026_

## What it is

PoolTerminal is a desktop application for SPOs running their own Cardano block producer. It connects to your node — over SSH, or directly when run on the node itself — and presents a rich, real-time operational dashboard that goes far beyond what gLiveView or generic chain explorers offer.

It is **read-only by design** — no transaction signing, no key access, no node control from the GUI. Your keys never leave your node. PoolTerminal observes and reports; it does not act. It runs on your own machine and stores nothing on anyone else's servers.

## Why

Running a Cardano stake pool produces a torrent of operational data that's locked away in log files, sqlite databases, Prometheus endpoints, cardano-cli outputs and external APIs. Existing tools surface a fraction of it. PoolTerminal pulls it all together in one place, visualises it properly, and stores history locally so you can see trends over weeks and months — not just snapshots.

## Features

Working today:

- **NOW** — Live current-epoch dashboard: chain pulse, tip/sync, KES expiry (with on-disk vs on-chain **operational certificate counter** and a health check), ideal/leader, era badge, mempool, peer counts, and a compact relay map. **Upcoming blocks** lists your assigned leader slots for the current *and* next epoch (once the ~36 h leadership-schedule window opens), each with a live countdown — sourced from the authoritative `cardano-cli` leadership schedule and cached per epoch. Views repaint instantly from cache on return, refreshing live behind.
- **HISTORY** — Full per-epoch table back to your pool's first epoch: blocks, ideal, luck, delegators, active stake, and a colour-coded six-way reward split (delegator reward · pledge · min-fee · margin · **SPO earnings** · total payout), where SPO earnings is the operator's own take per epoch. Charts for blocks-per-epoch and luck.
- **DELEGATORS** — One data-rich, sortable table of every delegator, merging live stake with a computed **loyalty** ranking (tenure × stake-weight × penalties for defection/withdrawal). Sort by loyalty or stake, dust filter, paginated. **Search by stake address** to jump straight to a delegator and highlight their row, and **copy** any full stake address with one click. Click any delegator for a deep-dive: balance, rewards, withdrawals, DRep flag, and a colourful **pool-movement journey** showing every pool they've delegated to with entry/exit epochs and active stake at each. Each row has two history buttons: **Delegation history** (the pool-movement journey) and **Stake history** — a per-epoch active-stake table (balance, change, running balance going back in time) paired with a running-balance line graph across the delegator's whole history. Stake history works from db-sync, Koios *or* Blockfrost; on db-sync it additionally shows intra-epoch movements (rewards in, withdrawals out). The deep-dive works from db-sync, Koios *or* Blockfrost; the loyalty leaderboard needs db-sync or Blockfrost (Koios can't compute it).
- **NODE HEALTH** — Host and node-process metrics (CPU, memory, peers, resources) with historical samples.
- **NOTIFICATIONS** — A live feed of delegation activity, detected on-chain within minutes: delegators joining (with the pool they came from), transfers in, **returning** delegators (anyone who was ever delegated before), redelegations away, and stake increases/decreases. Each event is colour-coded with a from→to flow, amount, epoch, slot, UTC timestamp and a one-click Cardanoscan transaction link. Each event's stake address can be **copied** with one click (handy for pasting into the Delegators search). When a returning delegator's true prior pool can't be resolved from the active source (e.g. a same-epoch multi-hop that epoch-grained APIs can't see), the event is honestly labelled **Returning Former Delegator** with the origin shown as unknown and a hint that db-sync resolves the full transfer chain. A **Clear history** button wipes the displayed feed while leaving monitoring intact. Corner toasts surface activity from any tab, and an unread badge tracks new events. A built-in advisor scales the polling cadence to your delegator count and chosen source so notifications stay within free-tier limits.
- **DATA** — A transparency screen showing exactly which source is answering each feature (node, db-sync, Koios or Blockfrost), and what each optional source would unlock.
- **MAP** — Full-size D3 world map (Natural Earth, cached offline after first load) plotting your node and its live peers, geo-located, with RTT-coloured connections and a side panel of latency bands and geographic distribution.
- **SETUP WIZARD** — A first-run guided walkthrough: connect to your node, then optionally add db-sync and/or Blockfrost, with notification cadence tuned to your pool size. Re-runnable any time from Settings.
- **DEMO MODE** — Built-in synthetic pool data so you can try the full UI without connecting to a real node.

Planned next: **REWARDS** and **GOVERNANCE (DRep)** views.

## Data sources

PoolTerminal needs only **your node plus an internet connection** to be fully useful. Optional sources enrich it. It picks the best available source for each piece of data automatically.

- **Your node** (required) — all live data: chain tip, sync, KES, leader schedule, blocks, peers, mempool, host health. Read over SSH (or directly when run on the node).
- **Koios** (the baseline, free) — a public Cardano API needing only internet. Provides pool summary, delegator list, per-epoch history, live notifications, and the delegator deep-dive. This alone is a complete setup, and it's all most operators need.
- **db-sync** (optional) — read your own Cardano db-sync Postgres directly. Because it's your own data there are no API limits and history loads instantly: full per-epoch history, the delegator deep-dive and the **loyalty leaderboard**, straight from your own machine.
- **Blockfrost** (optional) — a free project key that gives almost everything db-sync does without running a database: pool summary, delegator list and deep-dive, full per-epoch history, live notifications, and the **loyalty leaderboard**. A good middle ground for richer delegator features without db-sync.

When more than one source can answer, PoolTerminal prefers your own db-sync where you have it, then the public services. You can see exactly who serves what on the DATA tab, and there's a plain-language explanation under Settings → About.

### Capability matrix

| Capability | Node | Koios | db-sync | Blockfrost |
|---|:---:|:---:|:---:|:---:|
| Live node data (tip, KES, peers, mempool, blocks) | ✓ | | | |
| Epoch history, pool parameters | | ✓ | ✓ | ✓ |
| Pool summary (live/active stake, saturation, pledge) | | ✓ | | ✓ |
| Live notifications | | ✓ | | ✓ |
| Delegator list | | ✓ | ✓ | ✓ |
| Delegator deep-dive | | ✓ | ✓ | ✓ |
| Loyalty leaderboard | | | ✓ | ✓ |

Almost every capability has a Koios path, so a node-plus-internet setup is complete on its own — the one exception is the loyalty leaderboard, which needs db-sync or Blockfrost. Those two are add-ons that take over what they do best, with no API limits in db-sync's case.

## Connecting

**To your node:**

- **Remote node (SSH)** — connect to your BP or relay over SSH. Supports password, password + 2FA (keyboard-interactive), SSH key files (auto-detected or custom path, encrypted keys via passphrase), and ssh-agent.
- **This machine (local)** — run PoolTerminal *on* the node itself; it executes commands directly, no SSH needed.

**To db-sync (if used):** a local Unix socket (db-sync on the same machine as PoolTerminal) or a direct TCP connection (db-sync exposed over the network). A third mode — tunnelling Postgres over the existing SSH connection, for a db-sync that only listens on a remote machine's localhost — is in development and not yet enabled.

Relays are supported and degrade gracefully — block-producer-only panels (KES, ideal, leader, upcoming blocks) are clearly marked and skipped, so a relay connects cleanly without waiting on data it can't have.

## Requirements

- Linux desktop (Ubuntu 22.04+, Debian 12+, Fedora 40+, or any modern distro with WebKitGTK 4.1)
- Access to your Cardano node — SSH to a remote node, or PoolTerminal running on the node
- A running Cardano node with the standard Guild Operators tooling layout
- An internet connection (for Koios, the built-in baseline source)
- (Optional) `cncli` on the node — some features unlock with cncli data
- (Optional) **db-sync** for the loyalty leaderboard and gap-free instant history
- (Optional) a **Blockfrost** project key as an alternative delegator-data source

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
- **Secrets are never persisted.** SSH passwords, OTP codes, and key passphrases live only in memory for the session — never written to disk. (A db-sync password is only stored if you explicitly opt in during setup.)
- **No telemetry.** PoolTerminal does not phone home. Network connections are: your node (SSH), your db-sync (if used), and read-only public APIs (Koios for pool stats, Blockfrost if you add a key, ip-api for peer geo-location). Nothing else.
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

Active development. Core data layer (all sources), connection (SSH + local), the setup wizard, and the NOW / HISTORY / DELEGATORS / NODE HEALTH / NOTIFICATIONS / DATA / MAP views are working, including per-delegator stake history, op cert counter monitoring, and honest returning-delegator labelling. Next: REWARDS / GOVERNANCE views.

## Contributing

Contributions welcome once the foundation is in place. For now, watch and star — feedback on the design is genuinely useful.

## Licence

Apache 2.0 — see `LICENSE`.

## Author

Built by [GNP1-dev](https://github.com/GNP1-dev) — operator of the [GNP1 (GrahamsNumberPlus1)](https://grahamsnumberplus1.com/) Cardano stake pool.

If PoolTerminal helps you operate your pool better, the most generous thing you can do in return is delegate to a pool that donates to charity — GNP1 donates to mental health causes, but plenty of other charity pools exist too.
