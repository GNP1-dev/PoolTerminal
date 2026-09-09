/**
 * PoolTerminal — shared 1 Hz UI ticker + change-detecting DOM writers.
 *
 * Why this exists (0.3.4): the Dashboard's heartbeat trace, the upcoming
 * blocks strip and the relay ECG each ran their own requestAnimationFrame
 * loop, rewriting DOM every frame (60/s) whether or not anything changed.
 * Under WebKitGTK that forced a full software repaint per frame — the blurred
 * SVG paths in particular re-rasterised their Gaussian filter 60 times a
 * second — and pinned a CPU core (WebKitWebProcess at 100-135%) for as long
 * as the app was open. Everything those loops animate is second-resolution
 * (elapsed timers, ETAs, a strip that scrolls 2 units/s), so one shared
 * setInterval at 1 Hz is all the motion they need.
 *
 * Rules:
 *   • Subscribers get called once a second while the page is visible.
 *   • When the window is hidden (document.hidden) the ticker stops entirely
 *     and <html> gains class "pt-paused" so CSS can freeze infinite
 *     animations (see components.css). On return it resumes and fires at once
 *     so nothing shows a stale second.
 *   • Use setTextIf / setStyleIf / setAttrIf for anything written per tick:
 *     they skip the write when the value has not changed, so a bar whose
 *     width moves 0.0002% a second never invalidates paint.
 */

// Two channels. "tick" is the 1 Hz beat for everything second-resolution.
// "motion" is a slow 8 Hz beat for the few decorative movements that need
// sub-second steps (the hourglass sand drips): eight tiny repaints a second
// instead of the sixty a SMIL or CSS animation costs, and it pauses with the
// rest when the window is hidden. Nothing in the app needs more than that.
const CHANNELS = {
  tick:   { ms: 1000, subs: new Set(), timer: null },
  motion: { ms: 125,  subs: new Set(), timer: null },
};
let paused = false;

function fire(ch) {
  const now = Date.now();
  for (const fn of Array.from(ch.subs)) {
    try { fn(now); } catch (e) { /* one bad subscriber must not stop the rest */ }
  }
}

function ensureRunning(ch) {
  if (ch.timer || paused || ch.subs.size === 0) return;
  ch.timer = setInterval(() => fire(ch), ch.ms);
}

function halt(ch) {
  if (ch.timer) { clearInterval(ch.timer); ch.timer = null; }
}

function subscribe(ch, fn) {
  if (typeof fn !== 'function') return () => {};
  ch.subs.add(fn);
  ensureRunning(ch);
  return () => { ch.subs.delete(fn); if (ch.subs.size === 0) halt(ch); };
}

/** Subscribe `fn(nowMs)` to the 1 Hz tick. Returns an unsubscribe function. */
export function onTick(fn) { return subscribe(CHANNELS.tick, fn); }

export function offTick(fn) {
  const ch = CHANNELS.tick;
  ch.subs.delete(fn);
  if (ch.subs.size === 0) halt(ch);
}

/** Subscribe `fn(nowMs)` to the 8 Hz motion beat. Returns an unsubscribe function. */
export function onMotion(fn) { return subscribe(CHANNELS.motion, fn); }

export const MOTION_MS = CHANNELS.motion.ms;

export function isTickerPaused() { return paused; }

function applyVisibility() {
  const hidden = !!document.hidden;
  paused = hidden;
  try { document.documentElement.classList.toggle('pt-paused', hidden); } catch (e) { /* noop */ }
  for (const ch of Object.values(CHANNELS)) {
    if (hidden) {
      halt(ch);
    } else {
      ensureRunning(ch);
      if (ch.subs.size) fire(ch);   // repaint immediately on return; do not wait a beat
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', applyVisibility);
  applyVisibility();
}

// ---- change-detecting writers ---------------------------------------------
// Cache the last value we wrote per element+key. Comparing against our own
// cache (not the DOM) is cheap and reliable: reading style.background back
// returns a normalised rgb() string that would never compare equal.
const last = new WeakMap();
function slot(el) {
  let m = last.get(el);
  if (!m) { m = new Map(); last.set(el, m); }
  return m;
}

/** Set textContent only if it differs from what we last wrote. */
export function setTextIf(el, value) {
  if (!el) return false;
  const v = value == null ? '' : String(value);
  const m = slot(el);
  if (m.get('#text') === v) return false;
  m.set('#text', v);
  el.textContent = v;
  return true;
}

/** Set an inline style property only if it differs from what we last wrote. */
export function setStyleIf(el, prop, value) {
  if (!el) return false;
  const v = value == null ? '' : String(value);
  const m = slot(el);
  const k = 'style:' + prop;
  if (m.get(k) === v) return false;
  m.set(k, v);
  el.style[prop] = v;
  return true;
}

/** Set an attribute only if it differs from what we last wrote. */
export function setAttrIf(el, name, value) {
  if (!el) return false;
  const v = value == null ? '' : String(value);
  const m = slot(el);
  const k = 'attr:' + name;
  if (m.get(k) === v) return false;
  m.set(k, v);
  el.setAttribute(name, v);
  return true;
}
