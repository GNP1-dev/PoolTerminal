/**
 * PoolTerminal — NODE HEALTH view.
 *
 * Node-direct only (host /proc + df via host-query, node /metrics via
 * metrics-query). Never touches Koios, so it works regardless of the Koios
 * switch and carries no rate-limit risk.
 *
 * Live values come from the last scrape (getLastHost / getLastMetrics, refreshed
 * by the 1s live loop). Historical sparklines read the samples table, which the
 * always-on health sampler fills every ~30s — so the trends grow richer the
 * longer the terminal runs.
 *
 * Layout (DESIGN.md view grammar):
 *   hero row   — CPU · RAM · Disk · Network · Node RSS · Forge health
 *   2-col grid — CPU% · RAM% · Network · Node RSS · Mempool · Disk free (sparklines)
 *   bottom     — live detail panel (load, uptime, swap, GC, peers, density, tip)
 */

import * as readModel from '../data/read-model.js';
import { getLastHost } from '../data/host-query.js';
import { getLastMetrics } from '../data/metrics-query.js';

const LIVE_REFRESH_MS = 2000;     // hero + detail
const SPARK_REFRESH_MS = 15000;   // re-pull samples + redraw
const SPARK_WINDOW_S = 6 * 3600;  // trailing 6h of samples

// ---- formatting -----------------------------------------------------------

function fmtBytes(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
  return Math.round(b) + ' B';
}
function fmtBps(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  if (b >= 1e6) return (b / 1e6).toFixed(2) + ' MB/s';
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB/s';
  return Math.round(b) + ' B/s';
}
function fmtPct(v, d = 0) { return v == null || !Number.isFinite(v) ? '—' : v.toFixed(d) + '%'; }
function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function pctClass(v, warn, bad) {
  if (v == null) return 'v-muted';
  if (v >= bad) return 'v-bad';
  if (v >= warn) return 'v-warn';
  return 'v-good';
}

// ---- inline sparkline ------------------------------------------------------

const SW = 760, SH = 120, SPAD = 16;

function sparkline(samples, { color = 'var(--pt-accent-blue)', fill = 'var(--pt-accent-blue-soft)', fmt = (v) => v } = {}) {
  if (!samples || samples.length < 2) {
    return `<svg viewBox="0 0 ${SW} ${SH}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <text x="${SW / 2}" y="${SH / 2}" text-anchor="middle" class="pt-spark-empty">collecting…</text></svg>`;
  }
  const vals = samples.map((s) => s.v);
  const max = Math.max(...vals), min = Math.min(...vals);
  const range = (max - min) || 1;
  const innerW = SW - SPAD * 2, innerH = SH - SPAD * 2;
  const pts = samples.map((s, i) => {
    const x = SPAD + (i / (samples.length - 1)) * innerW;
    const y = SPAD + innerH - ((s.v - min) / range) * innerH;
    return [x, y];
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${(SPAD + innerW).toFixed(1)} ${(SPAD + innerH).toFixed(1)} L${SPAD.toFixed(1)} ${(SPAD + innerH).toFixed(1)} Z`;
  const yMax = `<text class="pt-spark-axis" x="2" y="${SPAD + 8}">${fmt(max)}</text>`;
  const yMin = `<text class="pt-spark-axis" x="2" y="${SPAD + innerH}">${fmt(min)}</text>`;
  return `<svg viewBox="0 0 ${SW} ${SH}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <path d="${area}" fill="${fill}" opacity="0.3"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.5"/>${yMax}${yMin}</svg>`;
}

// ---- template --------------------------------------------------------------

const HEALTH_HTML = `
  <style>
    .pt-health { display: flex; flex-direction: column; gap: var(--pt-gap, 8px); padding: 8px; height: 100%; overflow-y: auto; }
    .pt-health .pt-hero-row-6 { display: grid; grid-template-columns: repeat(6, 1fr); gap: var(--pt-gap, 8px); }
    .pt-health .pt-hero-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pt-health .pt-health-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--pt-gap, 8px); }
    .pt-health .pt-chart-body { padding: 6px 10px 4px; }
    .pt-health svg { width: 100%; height: auto; display: block; }
    .pt-health .pt-spark-axis { font: 400 10px ui-monospace, monospace; fill: var(--pt-text-muted); }
    .pt-health .pt-spark-empty { font: 400 12px ui-monospace, monospace; fill: var(--pt-text-muted); }
    .pt-health .pt-detail { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px 18px; padding: 10px 12px;
      font: 400 11px ui-monospace, monospace; }
    .pt-health .pt-detail .k { color: var(--pt-text-muted); }
    .pt-health .pt-detail .row { display: flex; justify-content: space-between; padding: 3px 0;
      border-bottom: 0.5px solid var(--pt-border); }
    .pt-health .pt-detail .v { color: var(--pt-text-primary); }
    .pt-health .v-good { color: var(--pt-status-good); }
    .pt-health .v-warn { color: var(--pt-status-warn); }
    .pt-health .v-bad  { color: var(--pt-status-bad, #e5484d); }
    .pt-health .v-muted { color: var(--pt-text-muted); }
  </style>
  <div class="pt-health" id="pt-health">
    <div class="pt-hero-row pt-hero-row-6">
      <div class="pt-hero-card"><div class="pt-hero-label">CPU</div><div class="pt-hero-value" id="hl-cpu">—</div><div class="pt-hero-sub" id="hl-cpu-sub">—</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">RAM</div><div class="pt-hero-value" id="hl-ram">—</div><div class="pt-hero-sub" id="hl-ram-sub">—</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Disk</div><div class="pt-hero-value" id="hl-disk">—</div><div class="pt-hero-sub" id="hl-disk-sub">—</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Network</div><div class="pt-hero-value" id="hl-net">—</div><div class="pt-hero-sub" id="hl-net-sub">—</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Node RSS</div><div class="pt-hero-value" id="hl-rss">—</div><div class="pt-hero-sub" id="hl-rss-sub">—</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Forge</div><div class="pt-hero-value" id="hl-forge">—</div><div class="pt-hero-sub" id="hl-forge-sub">—</div></div>
    </div>

    <div class="pt-health-grid">
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">CPU %</span><span class="pt-panel-meta v-muted" id="sp-cpu-meta">—</span></div><div class="pt-chart-body" id="sp-cpu"></div></div>
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">RAM %</span><span class="pt-panel-meta v-muted" id="sp-ram-meta">—</span></div><div class="pt-chart-body" id="sp-ram"></div></div>
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">Network in</span><span class="pt-panel-meta v-muted" id="sp-net-meta">—</span></div><div class="pt-chart-body" id="sp-net"></div></div>
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">Node RSS</span><span class="pt-panel-meta v-muted" id="sp-rss-meta">—</span></div><div class="pt-chart-body" id="sp-rss"></div></div>
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">Mempool bytes</span><span class="pt-panel-meta v-muted" id="sp-mem-meta">—</span></div><div class="pt-chart-body" id="sp-mem"></div></div>
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">Disk free</span><span class="pt-panel-meta v-muted" id="sp-disk-meta">—</span></div><div class="pt-chart-body" id="sp-disk"></div></div>
    </div>

    <div class="pt-panel">
      <div class="pt-panel-header"><span class="pt-panel-title">Live detail</span><span class="pt-panel-meta v-muted" id="hl-detail-meta">node-direct</span></div>
      <div class="pt-detail" id="hl-detail"></div>
    </div>
  </div>`;

// ---- live update -----------------------------------------------------------

function updateLive(canvas) {
  const host = getLastHost();
  const m = getLastMetrics() || {};
  const set = (id, v, cls) => {
    const el = canvas.querySelector('#' + id);
    if (!el) return;
    el.textContent = v;
    if (cls !== undefined) el.className = el.id.startsWith('hl-') && el.classList.contains('pt-hero-value')
      ? 'pt-hero-value ' + cls : cls;
  };

  // CPU
  const cpu = host?.cpuPct;
  set('hl-cpu', fmtPct(cpu), pctClass(cpu, 80, 95));
  set('hl-cpu-sub', host ? `${host.cores ?? '—'} cores · load ${host.load1 ?? '—'}` : '—');
  // RAM
  const ram = host?.memUsedPct;
  set('hl-ram', fmtPct(ram), pctClass(ram, 85, 95));
  set('hl-ram-sub', host && host.memTotal ? `${fmtBytes(host.memTotal - host.memAvail)} / ${fmtBytes(host.memTotal)}` : '—');
  // Disk
  const disk = host?.diskUsedPct;
  set('hl-disk', fmtPct(disk), pctClass(disk, 80, 92));
  set('hl-disk-sub', host ? `${fmtBytes(host.diskFree)} free` : '—');
  // Network
  set('hl-net', host && host.netRxBps != null ? `↓${fmtBps(host.netRxBps)}` : '—');
  set('hl-net-sub', host ? `↑${fmtBps(host.netTxBps)} · ${host.iface ?? ''}` : '—');
  // Node RSS
  set('hl-rss', fmtBytes(m.rssBytes));
  set('hl-rss-sub', m.gcLiveBytes != null ? `GC live ${fmtBytes(m.gcLiveBytes)}` : '—');
  // Forge health (BP)
  const cannot = m.cannotForge, missed = m.slotsMissed, forged = m.blocksForged;
  const forgeBad = (cannot || 0) > 0 || (missed || 0) > 0;
  set('hl-forge', forgeBad ? 'CHECK' : (cannot == null ? '—' : 'OK'),
    forgeBad ? 'v-warn' : (cannot == null ? 'v-muted' : 'v-good'));
  set('hl-forge-sub', cannot == null ? '—' : `forged ${forged ?? 0} · missed ${missed ?? 0}`);

  // Live detail grid
  const detail = canvas.querySelector('#hl-detail');
  if (detail) {
    const rows = [
      ['Load 1m', host?.load1 ?? '—'],
      ['Load 5m', host?.load5 ?? '—'],
      ['Load 15m', host?.load15 ?? '—'],
      ['Uptime', fmtDur(host?.uptimeSec)],
      ['Swap used', host ? `${fmtPct(host.swapUsedPct, 1)} (${fmtBytes(host.swapUsed)})` : '—'],
      ['GC live', fmtBytes(m.gcLiveBytes)],
      ['GC heap', fmtBytes(m.gcHeapBytes)],
      ['Density', m.density != null ? (m.density * 100).toFixed(2) + '%' : '—'],
      ['Mempool', m.mempoolTxs != null ? `${m.mempoolTxs} tx · ${fmtBytes(m.mempoolBytes)}` : '—'],
      ['Peers hot', m.peersHot ?? '—'],
      ['Peers warm', m.peersWarm ?? '—'],
      ['Peers cold', m.peersCold ?? '—'],
      ['Conns in/out', `${m.incomingConns ?? '—'} / ${m.outgoingConns ?? '—'}`],
      ['Slot', m.slotNum != null ? Number(m.slotNum).toLocaleString('en-US') : '—'],
      ['Block', m.blockNum != null ? Number(m.blockNum).toLocaleString('en-US') : '—'],
      ['Forged', m.blocksForged ?? '—'],
    ];
    detail.innerHTML = rows.map(([k, v]) =>
      `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  }
}

async function updateSparklines(canvas) {
  const since = Math.floor(Date.now() / 1000) - SPARK_WINDOW_S;
  const get = async (metric) => { try { return await readModel.getSamples(metric, since); } catch { return []; } };
  const put = (id, svg) => { const el = canvas.querySelector('#' + id); if (el) el.innerHTML = svg; };
  const meta = (id, samples, fmt) => {
    const el = canvas.querySelector('#' + id);
    if (el) el.textContent = samples.length ? `${samples.length} pts · now ${fmt(samples[samples.length - 1].v)}` : 'collecting…';
  };

  const [cpu, ram, net, rss, mem, disk] = await Promise.all([
    get('cpu_pct'), get('mem_used_pct'), get('net_rx_bps'), get('rss_bytes'), get('mempool_bytes'), get('disk_free_bytes'),
  ]);

  put('sp-cpu', sparkline(cpu, { fmt: (v) => v.toFixed(0) + '%' }));
  meta('sp-cpu-meta', cpu, (v) => v.toFixed(0) + '%');
  put('sp-ram', sparkline(ram, { color: 'var(--pt-accent-blue-bright)', fmt: (v) => v.toFixed(0) + '%' }));
  meta('sp-ram-meta', ram, (v) => v.toFixed(0) + '%');
  put('sp-net', sparkline(net, { color: 'var(--pt-status-good)', fill: 'var(--pt-status-good)', fmt: fmtBps }));
  meta('sp-net-meta', net, fmtBps);
  put('sp-rss', sparkline(rss, { fmt: fmtBytes }));
  meta('sp-rss-meta', rss, fmtBytes);
  put('sp-mem', sparkline(mem, { color: 'var(--pt-accent-blue-bright)', fmt: fmtBytes }));
  meta('sp-mem-meta', mem, fmtBytes);
  put('sp-disk', sparkline(disk, { color: 'var(--pt-status-good)', fill: 'var(--pt-status-good)', fmt: fmtBytes }));
  meta('sp-disk-meta', disk, fmtBytes);
}

// ---- mount -----------------------------------------------------------------

let _liveTimer = null;
let _sparkTimer = null;

export async function mountNodeHealth(canvas) {
  canvas.innerHTML = HEALTH_HTML;
  updateLive(canvas);
  await updateSparklines(canvas);
  _liveTimer = setInterval(() => updateLive(canvas), LIVE_REFRESH_MS);
  _sparkTimer = setInterval(() => updateSparklines(canvas), SPARK_REFRESH_MS);
}

export function unmountNodeHealth() {
  if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
  if (_sparkTimer) { clearInterval(_sparkTimer); _sparkTimer = null; }
}
