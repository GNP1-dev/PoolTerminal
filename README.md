# PoolTerminal

**A Bloomberg-terminal-style desktop dashboard for Cardano stake pool operators.**

Dense. Real-time. Read-only. Packed with data nothing else surfaces.

---

> ⚠️ **Early development.** Not yet released. Star to follow progress.

## What it is

PoolTerminal is a desktop application for SPOs running their own Cardano block producer. It connects over SSH to your BP node and presents a rich, real-time operational dashboard that goes far beyond what gLiveView or generic chain explorers offer.

It is **read-only by design** — no transaction signing, no key access, no node control from the GUI. Your keys never leave your node. PoolTerminal observes and reports; it does not act.

## Why

Running a Cardano stake pool produces a torrent of operational data that's locked away in log files, sqlite databases, Prometheus endpoints, cardano-cli outputs and external APIs. Existing tools surface a fraction of it. PoolTerminal pulls it all together in one place, visualises it properly, and stores history locally so you can see trends over weeks and months — not just snapshots.

## Planned features (v1.0)

- **NOW** — Live current-epoch dashboard. All upcoming blocks with individual countdowns, mempool feed, sync, KES, era badge, relay map.
- **HISTORY** — 30/90/365-day charts for luck, blocks, rewards, delegators, saturation, stake movement. Animated reward waterfalls.
- **DELEGATORS** — Full delegator table, churn analysis, top 20 by stake, loyalty heatmap, whale movement alerts.
- **NODE HEALTH** — CPU/mem/disk multi-day graphs, GC pauses, peer churn, block adopt-time histogram, error log feed.
- **REWARDS** — Epoch-by-epoch waterfall, fixed fee vs margin, you-vs-network ROA, delegator earnings detail.
- **GOVERNANCE** — DRep voting record, treasury proposals, upcoming votes, your votes vs network.
- **MAP** — D3 vector world map (Natural Earth 1:50m, bundled, offline-capable) showing your relay topology with live RTTs.
- **DEMO MODE** — Built-in synthetic pool data so you can try the full UI without connecting to a real node.

## Standout details

- **All upcoming blocks scrollable list** with individual countdowns — for pools with many blocks per epoch
- **Block adopt-time histogram** — your propagation latency vs the network
- **Delegator loyalty heatmap** — who's been with you how long
- **Pool pulse score** — composite health metric with 30-day sparkline
- **Network rank badges** — "your block propagation is faster than 87% of pools"
- **Live block production celebration** — small UI animation when your pool mints a block
- **Snapshot-vs-now diff** — the rewards calculation depends on stake at snapshot, not current; PoolTerminal visualises both
- **Missed block forensics** — if you miss a block, see why
- **Hard fork awareness** — built-in countdown, pre-fork checklist, era-aware queries

## Requirements

- Linux desktop (Ubuntu 22.04+, Debian 12+, Fedora 40+, or any modern distro with WebKitGTK 4.1)
- SSH access to your Cardano block producer node
- A running Cardano BP with the standard Guild Operators tooling layout
- (Optional) `cncli` installed on the node — many features unlock with cncli data

**Not required:** db-sync (we don't depend on it since most SPOs don't run it).

## Platform support

Linux is the only supported platform. The vast majority of SPOs run Linux desktops or have Linux VMs. macOS and Windows builds would require code signing fees and platform-specific testing that the project can't currently justify. Contributions welcome if anyone wants to port.

## Installation

> 🚧 Not yet available. First release expected Q3 2026.

When the first release lands, you'll be able to download:
- `.AppImage` — universal Linux binary, no install needed
- `.deb` — for Debian/Ubuntu

## Build from source

> 🚧 Will be added once the build is stabilised.

```bash
# Coming soon
```

## Trust & security

PoolTerminal is open source, Apache 2.0 licensed. Audit before you trust it. Key trust properties:

- **Read-only.** No commands that modify state on your node are issued.
- **Keys never leave the node.** PoolTerminal does not transmit keys, mnemonics, or wallet files anywhere.
- **No telemetry.** PoolTerminal does not phone home. Network connections are: your node (SSH), and Koios (read-only pool stats). Nothing else.
- **Local cache only.** Historical data is stored in a SQLite database on your own machine.

## Tech stack

- **Tauri 2** (Rust + Web frontend, native performance)
- **Vanilla JS** frontend (no framework bloat)
- **D3 + Apache ECharts** for visualisations
- **russh** for async SSH
- **rusqlite** for local data cache

## Hard fork awareness

PoolTerminal is built with Cardano's regular hard fork cycle in mind. See `HARDFORK.md` for the running list of fork-sensitive code areas and the current upgrade target.

## Status

Active development. Roadmap in `ROADMAP.md`.

## Contributing

Contributions welcome once the foundation is in place. For now, watch and star — feedback on the design is genuinely useful.

## Licence

Apache 2.0 — see `LICENSE`.

## Author

Built by [GNP1-dev](https://github.com/GNP1-dev) — operator of the [GNP1 (GrahamsNumberPlus1)](https://grahamsnumberplus1.com/) Cardano stake pool.

If PoolTerminal helps you operate your pool better, the most generous thing you can do in return is delegate to a pool that donates to charity — GNP1 donates to mental health causes, but plenty of other charity pools exist too.
