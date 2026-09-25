/**
 * PoolTerminal — shared formatting helpers.
 * Used across every panel. Keep all number/time formatting here so the UI is
 * consistent (DESIGN.md §10: abbreviated in cards, full in tables; tabular nums).
 */

/** "187,972,611" — full precision with thousands separators (tables, tickertape). */
export function commas(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** "100.0%" */
export function pct(n, dp = 1) {
  return n.toFixed(dp) + '%';
}

/** "50M", "1.2K", "9.3B" — abbreviated (cards). */
export function abbreviate(n, dp = 1) {
  const abs = Math.abs(n);
  const strip = (x) => x.toFixed(dp).replace(/\.0+$/, '');
  if (abs >= 1e9) return strip(n / 1e9) + 'B';
  if (abs >= 1e6) return strip(n / 1e6) + 'M';
  if (abs >= 1e3) return strip(n / 1e3) + 'K';
  return String(Math.round(n));
}

/** Compact countdown: "3d 5h" / "18h 42m" / "4m 08s" / "47s". */
export function duration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (x) => String(x).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${p2(m)}m`;
  if (m > 0) return `${m}m ${p2(sec)}s`;
  return `${sec}s`;
}

// ---- Mempool queue in blocks (item 18) -------------------------------------
// The mempool queue is shown in BLOCKS everywhere (NOW panel, chart, MAX column,
// relay tanks): bytes / maxBlockBodySize. The key level is 2 blocks: a default
// mempool is 2 × max block body, most pools run the default, so from 2 blocks
// queued most of the network starts rejecting new transactions, whatever this
// node's own capacity is. % is used only for fill of the node's real capacity.
export const MAX_BLOCK_BODY = 90112;          // bytes, mainnet maxBlockBodySize
export const DEFAULT_MEMPOOL_BLOCKS = 2;      // default mempool = 2 blocks
export const MEMPOOL_NEAR_BLOCKS = 1.5;       // "approaching 2" from here

/** Queue size in blocks: "3.7 blk", "<0.1 blk", "0 blk"; "—" when unknown. */
export function fmtBlk(blocks) {
  if (blocks == null || !isFinite(blocks)) return '—';
  if (blocks <= 0) return '0 blk';
  if (blocks < 0.1) return '<0.1 blk';
  return blocks.toFixed(1) + ' blk';
}

/** Level of a blocks-queued figure: 'good' | 'warn' (approaching 2) | 'bad' (2+). */
export function blkLevel(blocks) {
  if (blocks >= DEFAULT_MEMPOOL_BLOCKS) return 'bad';
  if (blocks >= MEMPOOL_NEAR_BLOCKS) return 'warn';
  return 'good';
}

/** Alert wording at 2+ blocks queued (NOW bar and the "Mempool full" alert). */
export const MEMPOOL_2BLK_ALERT =
  "2+ blocks queued: most pools' mempools are full, new transactions may be rejected across the network";

/** Fill of the node's real mempool capacity: "0.5% of 64 MB"; "—" if unknown. */
export function fmtCapFill(bytes, capacityBytes) {
  if (!(capacityBytes > 0) || bytes == null) return '—';
  const p = (bytes / capacityBytes) * 100;
  const pTxt = p > 0 && p < 0.1 ? '<0.1' : p.toFixed(p < 10 ? 1 : 0);
  const cap = capacityBytes >= 1048576 ? `${Math.round(capacityBytes / 1048576)} MB`
    : `${Math.round(capacityBytes / 1024)} KB`;
  return `${pTxt}% of ${cap}`;
}
