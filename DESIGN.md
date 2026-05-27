# PoolTerminal — Design specification

**Canonical reference for every visual decision in PoolTerminal. Anything that ships should be checkable against this document.**

---

## 1. Philosophy

Bloomberg-terminal-dense, Cardano-blue accented, on charcoal. Every pixel earns its place. Read-only by design. Numbers read as numbers (monospace, tabular). Status is colour, not noise. Real-time updates flash so the operator sees what changed.

Praos is probabilistic — long gaps between blocks are normal. Colour is reserved for actual node health, never the chain's natural rhythm.

## 2. Colour palette

| Token | Hex | Use |
|---|---|---|
| `--pt-bg-canvas` | `#0F1419` | Main app background |
| `--pt-bg-panel` | `#161B26` | Card / panel surface |
| `--pt-bg-strip` | `#0A0E15` | Tickertape and panel header strip |
| `--pt-border` | `#1F2937` | All borders (0.5px solid) |
| `--pt-accent-blue` | `#4A8FE7` | Primary accent — Cardano-inspired, readable on dark |
| `--pt-accent-blue-soft` | `#2C4763` | Chart fills, secondary blue |
| `--pt-accent-blue-bright` | `#7BB0F5` | Active state, just-changed marker |
| `--pt-status-good` | `#10B981` | Healthy state, value up |
| `--pt-status-warn` | `#F59E0B` | Warning, value approaching threshold |
| `--pt-status-bad` | `#EF4444` | Problem, value past hard threshold |
| `--pt-text-primary` | `#E5E7EB` | Body and value text |
| `--pt-text-secondary` | `#9CA3AF` | Panel titles |
| `--pt-text-muted` | `#6B7280` | Labels, units, hints |
| `--pt-text-disabled` | `#374151` | Inactive tabs, separators |

## 3. Typography

Two-family hybrid:

- **Sans** (`system-ui` stack) — chrome, labels, panel titles, prose
- **Mono** (`ui-monospace` stack) — all data values, numbers, hashes, addresses

Mono uses tabular numerals automatically. Only two weights: 400 regular, 500 medium. Sentence case for prose; ALLCAPS reserved for labels (0.7px letter-spacing).

### Type scale

| Token | Size | Use |
|---|---|---|
| `--pt-text-label` | 11px | Uppercase labels |
| `--pt-text-data` | 11px | Mono data in tables, lists, tickertape |
| `--pt-text-data-mid` | 13px | Stat cell values |
| `--pt-text-data-large` | 22px | Hero card values |
| `--pt-text-data-xl` | 32px | Dashboard hero readouts |

## 4. Density

11px base. Tight padding throughout. Designed for fluid window sizing, optimised for 1440-1920 wide displays but works smaller and larger.

- Panel header vertical pad: 7px
- Panel body padding: 9-11px
- Card gap: 8px (`--pt-gap`)
- Table cell padding: 7px 11px

## 5. Layout chrome

```
┌──────────────────────────────────────────────────────┐
│ Tickertape strip — global, always visible            │
├──────────────────────────────────────────────────────┤
│ Tab bar — NOW · HISTORY · DELEGATORS · ...           │
├──────────────────────────────────────────────────────┤
│                                                       │
│ View canvas — fluid, view-specific layout             │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Tickertape** lives at top, always shows: ticker, epoch, slot, sync%, KES days, peers, forging status, LIVE / DEMO badge. Persistent across every view. **Tab bar** selects view. **Canvas** owns the rest.

## 6. Panel grammar

Every panel has:

1. **Header strip** (7px vertical pad, `--pt-bg-strip` background, 0.5px bottom border)
   - Title left: sans, 11px, uppercase, 0.7px tracking, `--pt-text-secondary`
   - Optional right-side metadata: mono, 11px, `--pt-text-muted`
2. **Body** — varies by panel type, 9-11px padding

## 7. View grammar

Every view follows the same skeleton:

- **Hero row** — 4-5 hero cards spanning full width (the headline metrics)
- **Middle** — 2-column grid of medium panels (charts, tables, lists)
- **Bottom** — full-width panel for the deepest single data structure (waterfall, log feed, full table, map)

## 8. Animation

Bloomberg-flash on every changing cell:

- Value increased → green tint (`pt-flash-up`)
- Value decreased → red tint (`pt-flash-down`)
- Duration 1.6s, ease-out
- Numeric value updates instantly; only the background tints

No spinners. No loading shimmer. Stale data shown at 60% opacity, replaced when fresh.

## 9. Status semantics

- **Cardano blue** — primary accent, informational ("this is a value worth noting")
- **Green** — healthy, value increased, success
- **Amber** — warning, value approaching threshold (KES < 30d, saturation > 80%, etc)
- **Red** — error, failure, value past hard threshold (KES < 7d, sync lost, etc)

Pulse score badge: green ≥ 85, amber 60-84, red < 60.

**Reserved rule:** the "since last block" readout and tip difference are NEVER colour-coded red. They are informational. The single health signal for chain alignment is the AT TIP badge — green if synced, amber if behind, red if significantly behind.

## 10. Number formatting

- **Cards** — abbreviated (50M ADA, 1.2K delegators, 47s)
- **Tables, detail views, tooltips** — full precision (50,123,456 ADA)
- **All numeric output** — tabular numerals via monospace

## 11. Pool pulse formula

Composite 0-100 health score, recomputed on every refresh:

| Component | Weight | Source |
|---|---|---|
| Block performance | 25% | Adopted ÷ Leader (last 5 epochs) |
| Propagation health | 20% | Adopt-time percentile vs network |
| Node uptime | 15% | % healthy slots, last 24h |
| KES freshness | 10% | Linear, 90d = 100 / 0d = 0 |
| Peer health | 10% | In/out peers within healthy range |
| Delegator stability | 10% | Churn vs 30-day baseline |
| Saturation headroom | 5% | Distance from 100% saturation |
| Pledge compliance | 5% | Binary 0 or 5 |

Tap the pulse badge → drill-down panel showing each component score with worst-performing items highlighted.

## 12. Chain pulse spec

Located in the NOW view. Three stacked elements inside one panel:

1. **"Since last block"** — large mono readout, neutral colour, never red. Right side shows avg/max/min over 5 min window.
2. **Heartbeat strip** — last 5 min, vertical tick at every block arrival. Latest tick brighter blue. Dashed green "now" marker at right edge. Visually irregular (like AF arrhythmia trace) — that's Praos doing what Praos does.
3. **Density readouts** — 5min / 1h / 24h / 7d / epoch density (blocks ÷ slots). Healthy mainnet ~5%. Within ±0.5% green, further amber, way off red.

The only red/amber indicator on the panel is the AT TIP badge in the header.

## 13. Demo mode

A LIVE / DEMO toggle sits at the right end of the tickertape strip. In DEMO mode:

- All data sourced from `src/data/demo.js`
- Persistent "DEMO MODE" tint across the whole UI (subtle amber border at app edge)
- All side-effect actions disabled
- Synthetic pool "DEMO1" — 50M live stake, ~20 blocks/epoch, 500 delegators

## 14. Hard fork awareness

- Era badge always visible in tickertape
- Pre-fork checklist panel appears 30 days before known fork
- All era-sensitive code paths marked `// HARDFORK:` for grep audit
- Demo fixtures frozen per era

## 15. Iconography

Outline icons only. No emoji. Status dots are 6px circles in `--pt-status-good/warn/bad`. The "● LIVE" badge in the tickertape uses a small filled circle followed by the word.

## 16. Tables

- Header row: `--pt-bg-strip` background, 11px uppercase sans labels in `--pt-text-secondary`
- Body cells: 11px mono, `--pt-text-primary`, 7px 11px padding
- Row separators: 0.5px `--pt-border`
- Hover state: row background lifts to `#1A2030`
- Sortable columns: small chevron in `--pt-text-muted`, blue when active

## 17. Sparklines

Used in stat cards and inline next to values. 60px wide × 18px tall by default. Single colour (`--pt-accent-blue`), no axes, no grid. Optional final-point dot in `--pt-accent-blue-bright`.

---

This document is the canonical reference. If a component disagrees with it, the component is wrong.
