# PoolTerminal

**A Bloomberg-terminal-style desktop dashboard for Cardano stake pool operators.**

Dense. Real-time. Read-only. Packed with data nothing else surfaces.

---

> ⚠️ **Early development.** Not yet released. Star to follow progress.

> _Last updated: 6 July 2026_ <!-- readme-v69 -->

## What it is

PoolTerminal is a desktop application for SPOs running their own Cardano block producer. It connects to your node — over SSH, or directly when run on the node itself — and presents a rich, real-time operational dashboard that goes far beyond what gLiveView or generic chain explorers offer.

It is **read-only by design** — no transaction signing, no key access, no node control from the GUI. Your keys never leave your node. PoolTerminal observes and reports; it does not act. It runs on your own machine and stores nothing on anyone else's servers.

## Why

Running a Cardano stake pool produces a torrent of operational data that's locked away in log files, sqlite databases, Prometheus endpoints, cardano-cli outputs and external APIs. Existing tools surface a fraction of it. PoolTerminal pulls it all together in one place, visualises it properly, and stores history locally so you can see trends over weeks and months — not just snapshots.

## Features

Working today:

- **NOW** — Live current-epoch dashboard: chain pulse, tip/sync, KES expiry (with on-disk vs on-chain **operational certificate counter** and a health check), ideal/leader, era badge, an intelligent **mempool** panel (fill shown against the one-block clearing limit with a "max block size reached" alert, plus a live **data-flow rate** in KB/min that reveals real transaction demand independent of block timing, traced in a second line on the mempool graph), **block propagation** timings down to sub-second buckets with a rolling per-block history strip, peer counts, and a compact relay map. **Upcoming blocks** lists your assigned leader slots for the current *and* next epoch (once the ~36 h leadership-schedule window opens) as horizontal rows, next-to-mint first and scrollable, each with a progress bar that fills and warms toward red as the slot nears, a live d:h:m:s countdown, the day/time and slot number — sourced from the authoritative `cardano-cli` leadership schedule and cached per epoch. A live **Metadata feed** streams CIP-20 transaction messages from across the chain as blocks arrive — the actual notes people attach to their transactions — buffered and released at a steady pace so it reads as a continuous ticker; a funnel menu filters out DEX/bot spam, betting markets and profanity, with a pause control, scroll-back and per-message timestamps (needs db-sync). Views repaint instantly from cache on return, refreshing live behind.
- **HISTORY** — Full per-epoch table back to your pool's first epoch: blocks, ideal, luck, delegators, active stake, and a colour-coded six-way reward split (delegator reward · pledge · min-fee · margin · **SPO earnings** · total payout), where SPO earnings is the operator's own take per epoch. Charts for blocks-per-epoch and luck.
- **DELEGATORS** — One data-rich, sortable table of every delegator, merging live stake with a computed **loyalty** ranking (tenure × stake-weight × penalties for defection/withdrawal). Sort by loyalty or stake, dust filter, paginated. **Search by stake address** to jump straight to a delegator and highlight their row, and **copy** any full stake address with one click. Click any delegator for a deep-dive: balance, rewards, withdrawals, DRep flag, and a colourful **pool-movement journey** showing every pool they've delegated to with entry/exit epochs and active stake at each. Each row has two history buttons: **Delegation history** (the pool-movement journey) and **Stake history** — a per-epoch active-stake table (balance, change, running balance going back in time) paired with a running-balance line graph across the delegator's whole history. Stake history works from db-sync, Koios *or* Blockfrost; on db-sync it additionally shows intra-epoch movements (rewards in, withdrawals out). The deep-dive works from db-sync, Koios *or* Blockfrost; the loyalty leaderboard needs db-sync or Blockfrost (Koios can't compute it).
- **NODE HEALTH** — Host and node-process metrics (CPU, memory, peers, resources) with historical samples.
- **NOTIFICATIONS** — A live feed of delegation activity, detected on-chain within minutes: delegators joining (with the pool they came from), transfers in, **returning** delegators (anyone who was ever delegated before), redelegations away, and stake increases/decreases. Each event is colour-coded with a from→to flow, amount, epoch, slot, UTC timestamp and a one-click Cardanoscan transaction link. Each event's stake address can be **copied** with one click (handy for pasting into the Delegators search). When a returning delegator's true prior pool can't be resolved from the active source (e.g. a same-epoch multi-hop that epoch-grained APIs can't see), the event is honestly labelled **Returning Former Delegator** with the origin shown as unknown and a hint that db-sync resolves the full transfer chain. A **Clear history** button wipes the displayed feed while leaving monitoring intact. Corner toasts surface activity from any tab, and an unread badge tracks new events. A built-in advisor scales the polling cadence to your delegator count and chosen source so notifications stay within free-tier limits. Systemic shifts that would otherwise flood the feed — the whole stake distribution moving at an epoch boundary, a data-source switch changing the stake basis, or any mass change across many delegators at once — are detected and absorbed silently, so only genuine per-delegator activity surfaces.
- **DATA** — A transparency screen showing exactly which source is answering each feature (node, db-sync, Koios or Blockfrost), and what each optional source would unlock.
- **MAP** — Full-size D3 world map (Natural Earth, cached offline after first load) plotting your node and its live peers, geo-located, with RTT-coloured connections and a side panel of latency bands and geographic distribution.
- **RELAY 1 / RELAY 2** — Dedicated live dashboards for your relays, each monitored independently and in full isolation from the block producer and from each other (a relay stalling flatlines only its own heartbeat; the others are unaffected). Every reading comes straight from that relay's own cardano-node, Prometheus-only, over its own SSH session (or locally) — no Koios, db-sync, Blockfrost or cache. Each tab carries a red heartbeat, density (with a one-hour settle countdown, since relays do not backfill historical blocks), mempool, tip diff with a true sync reading (100% through normal inter-block gaps, falling only when genuinely behind), an epoch countdown, block propagation, a scrollable per-peer list (IP · RTT · country, sorted fastest first) and a geolocated relay map centred on that relay's own location. When a host runs a co-located block producer and relay (e.g. a dual-NIC box with the BP in `cnode_bp` and the relay in `cnode_relay`), a node selector picks the relay automatically (preferring the node with no KES key) or by an explicit filter. Polling continues in the background while you work in other tabs, with a live connection timer, so returning to a relay is seamless with no gap in its data.
- **SETUP WIZARD** — A first-run guided walkthrough with a Koios-first flow: choose the free tier or enter an API key, connect to your node, then optionally add db-sync and/or Blockfrost, with notification cadence tuned automatically to your pool size and Koios tier. The db-sync step is a guided decision tree — is it on this machine, on your block producer, or on another machine — asking only for the fields each case needs, with inline info-icons that explain every requirement and hand you copy-paste setup commands, and a Test button that reports exactly which stage failed in plain words. For a remote db-sync it also handles the SSH key: point it at an existing key, have PoolTerminal **generate a dedicated key for you** on the spot, or take a step-by-step explained walkthrough — it then shows the public key and the exact commands to authorise it on the db-sync host, and carries the key path straight into the connection screen. Single-choice screens auto-advance and you can step back at any point before connecting. Re-runnable any time from Settings, or from a **Developer mode** panel that can force the wizard or reset everything for a clean run.
- **DEMO MODE** — Built-in synthetic pool data so you can try the full UI without connecting to a real node.

Planned next: **REWARDS** and **GOVERNANCE (DRep)** views.

## Data sources

PoolTerminal needs only **your node plus an internet connection** to be fully useful. Optional sources enrich it. It picks the best available source for each piece of data automatically.

- **Your node** (required) — all live data: chain tip, sync, KES, leader schedule, blocks, peers, mempool, host health. Read over SSH (or directly when run on the node).
- **Koios** (the baseline, free) — a public Cardano API needing only internet. Provides pool summary, delegator list, per-epoch history, live notifications, and the delegator deep-dive. This alone is a complete setup, and it's all most operators need.
- **db-sync** (optional) — read your own Cardano db-sync Postgres directly. Because it's your own data there are no API limits and history loads instantly: full per-epoch history, the delegator deep-dive and the **loyalty leaderboard**, straight from your own machine. db-sync can sit on the same machine, on your block producer, or on a separate box — PoolTerminal reaches a remote one by opening its own key-based SSH tunnel to it, so Postgres is never exposed to the network. It also powers the live chain **Metadata feed**.
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
| Chain metadata feed (live messages) | | | ✓ | |

Almost every capability has a Koios path, so a node-plus-internet setup is complete on its own — the one exception is the loyalty leaderboard, which needs db-sync or Blockfrost. Those two are add-ons that take over what they do best, with no API limits in db-sync's case.

## Connecting

**To your node:**

- **Remote node (SSH)** — connect to your BP or relay over SSH. Supports password, password + 2FA (keyboard-interactive), SSH key files (auto-detected or custom path, encrypted keys via passphrase), and ssh-agent.
- **This machine (local)** — run PoolTerminal *on* the node itself; it executes commands directly, no SSH needed.

**To db-sync (if used):** three modes, chosen in the setup wizard. **On this machine** — a local Unix socket. **On your block producer** — Postgres tunnelled over the node's existing SSH connection. **On another machine** — PoolTerminal opens its own dedicated SSH session to the db-sync host and reads Postgres over that tunnel; key-based auth bypasses any 2FA on the box, and database access is either a password or a loopback-trust line in `pg_hba.conf` (no password stored). Because the tunnel presents the connection to Postgres as loopback, the same setup works whether PoolTerminal runs on the node, a local machine, or a remote host — in any combination with where the block producer lives.

Relays have their own dedicated **Relay 1 / Relay 2** tabs (see Features) — purpose-built, node-only dashboards that read solely from each relay's own cardano-node and stay fully isolated from the block-producer view and from each other. They connect with the same options as above (local or SSH, every auth method), plus an optional node selector for hosts that run a co-located block producer and relay. You can also still point the main block-producer views at a relay, where block-producer-only panels (KES, ideal, leader, upcoming blocks) are clearly marked and skipped.

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
- **Secrets are never persisted.** SSH passwords, OTP codes, and key passphrases live only in memory for the session — never written to disk. (A db-sync password is only stored if you explicitly opt in during setup; the loopback-trust option stores no password at all.)
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

Active development. Core data layer (all sources), connection (SSH + local), the setup wizard, and the NOW / HISTORY / DELEGATORS / NODE HEALTH / NOTIFICATIONS / DATA / MAP views are working, including per-delegator stake history, op cert counter monitoring, and honest returning-delegator labelling. Dedicated **Relay 1 / Relay 2** monitoring tabs are now working too: isolated, node-only relay dashboards with heartbeat, density, mempool, tip/sync, epoch, block propagation, a scrollable peer list, a geolocated relay map, background-persistent polling, and automatic node selection for co-located BP+relay hosts. Next: REWARDS / GOVERNANCE views.

## Contributing

Contributions welcome once the foundation is in place. For now, watch and star — feedback on the design is genuinely useful.

## Licence

Apache 2.0 — see `LICENSE`.

## Author

Built by [GNP1-dev](https://github.com/GNP1-dev) — operator of the [GNP1 (GrahamsNumberPlus1)](https://grahamsnumberplus1.com/) Cardano stake pool.

If PoolTerminal helps you operate your pool better, the most generous thing you can do in return is delegate to a pool that donates to charity — GNP1 donates to mental health causes, but plenty of other charity pools exist too.
