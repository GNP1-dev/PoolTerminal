/**
 * Koios call meter + pause switch.
 *
 * Koios's free tier allows a fixed number of calls per day. Koios does not
 * report the running total on a normal response (only on a 429, where the body
 * reads "Exceeded Tier Limit, count was N"), so we tally calls ourselves at the
 * single runCmd() choke point in koios-query.js and koios-history.js.
 *
 * - Count is per UTC day (Koios resets on a UTC-day basis); rolls over at 00:00.
 * - A real count is captured whenever Koios returns a 429.
 * - When paused (manually, or auto on hitting the cap), the transport refuses to
 *   make any Koios call and returns empty, so the app falls back to db-sync.
 *
 * Pure module: no DOM, no network. localStorage only.
 */

const STORE_KEY = 'pt.koios.meter.v1';
const PAUSE_KEY = 'pt.koios.paused.v1';

// Free-tier defaults (no token). The LIVE values come from koiosLimits() below,
// which is tier-aware; these are kept for reference.
export const KOIOS_DAILY_LIMIT = 5000;   // free no-key tier
export const KOIOS_WARN_AT     = 4000;   // amber warning threshold (80%)
export const KOIOS_HARD_STOP   = 4900;   // auto-pause threshold (leave headroom)

import { hasKoiosToken } from './koios-token.js';

// Tier-aware daily limits, re-evaluated on each read so they adjust the moment a
// token is added or removed. Free (no token) = 5,000/day; registered token =
// 50,000/day. Hard-stop sits a touch under each ceiling for headroom.
export function koiosLimits() {
  return hasKoiosToken()
    ? { limit: 50000, warnAt: 40000, hardStop: 49000 }
    : { limit: 5000,  warnAt: 4000,  hardStop: 4900 };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function read() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const o = raw ? JSON.parse(raw) : null;
    if (o && o.date === todayUtc()) return o;
  } catch { /* ignore */ }
  // new day or no record → fresh
  return { date: todayUtc(), count: 0, koiosReported: null, last429: null };
}

function write(o) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

/** Increment the call tally. Call once per outgoing Koios request. */
export function recordCall(n = 1) {
  const o = read();
  o.count += n;
  write(o);
  // Auto-pause if we cross the hard stop, so we never blow the daily cap.
  if (o.count >= koiosLimits().hardStop && !isPaused()) {
    setPaused(true, 'auto: approaching daily limit');
  }
  return o.count;
}

/** Record a 429 from Koios: capture its authoritative count and auto-pause. */
export function record429(reportedCount = null) {
  const o = read();
  if (reportedCount != null && Number.isFinite(reportedCount)) {
    o.koiosReported = reportedCount;
    if (reportedCount > o.count) o.count = reportedCount; // trust Koios's number
  }
  o.last429 = new Date().toISOString();
  write(o);
  setPaused(true, 'auto: Koios returned 429 (limit reached)');
}

/** Current usage snapshot for the Settings panel. */
export function getUsage() {
  const o = read();
  const count = o.count;
  const { limit, warnAt } = koiosLimits();
  const pct = Math.min(100, Math.round((count / limit) * 100));
  let state = 'ok';
  if (count >= limit || isPaused()) state = 'over';
  else if (count >= warnAt) state = 'warn';
  return {
    date: o.date,
    count,
    limit,
    pct,
    remaining: Math.max(0, limit - count),
    state,                       // 'ok' | 'warn' | 'over'
    paused: isPaused(),
    pauseReason: pauseReason(),
    koiosReported: o.koiosReported,
    last429: o.last429,
  };
}

/** Manual reset (e.g. a "reset counter" button), keeps the date as today. */
export function resetCount() {
  write({ date: todayUtc(), count: 0, koiosReported: null, last429: null });
}

// ---- pause switch ----------------------------------------------------------

export function isPaused() {
  try { return localStorage.getItem(PAUSE_KEY) === '1'; } catch { return false; }
}

export function pauseReason() {
  try { return localStorage.getItem(PAUSE_KEY + '.why') || null; } catch { return null; }
}

export function setPaused(on, reason = '') {
  try {
    if (on) {
      localStorage.setItem(PAUSE_KEY, '1');
      localStorage.setItem(PAUSE_KEY + '.why', reason || 'manual');
    } else {
      localStorage.removeItem(PAUSE_KEY);
      localStorage.removeItem(PAUSE_KEY + '.why');
    }
  } catch { /* ignore */ }
}

/**
 * Detect a Koios tier-limit response and capture the reported count.
 * Returns true if the body is a 429/limit message (caller should treat as fail).
 * Koios 429 body looks like: "Exceeded Tier Limit, count was 10116"
 */
export function looksLikeLimit(body) {
  if (typeof body !== 'string') return false;
  const m = /Exceeded Tier Limit, count was (\d+)/i.exec(body);
  if (m) { record429(Number(m[1])); return true; }
  if (/Exceeded Tier Limit/i.test(body)) { record429(null); return true; }
  return false;
}
