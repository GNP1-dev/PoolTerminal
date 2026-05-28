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
