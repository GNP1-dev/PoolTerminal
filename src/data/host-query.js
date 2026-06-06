/**
 * PoolTerminal — host OS metrics scrape.
 *
 * cardano-node's Prometheus endpoint reports the NODE PROCESS only. Host-level
 * health (CPU%, RAM, disk free, network throughput, load) comes from the OS, so
 * we read /proc and df over the same SSH session. Node-direct, no Koios.
 *
 * Rate metrics (CPU%, network bytes/s) are deltas between successive scrapes,
 * computed here against the previous sample. The first scrape returns null rates.
 *
 * One bundled SSH command, sections split by @MARKER lines, so it's a single
 * round-trip per scrape.
 */

import { invoke } from './tauri.js';

const HOST_CMD = [
  "echo '@DISK'; df -B1 / | tail -1",
  "echo '@STAT'; head -1 /proc/stat",
  "echo '@MEM'; grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' /proc/meminfo",
  "echo '@LOAD'; cat /proc/loadavg",
  "echo '@UP'; cat /proc/uptime",
  "echo '@CORES'; nproc",
  "echo '@NET'; cat /proc/net/dev",
  "echo '@IFACE'; ip route | grep -m1 default",
].join('; ');

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

function section(text, marker, next) {
  const start = text.indexOf('@' + marker);
  if (start < 0) return '';
  const from = text.indexOf('\n', start) + 1;
  const end = next ? text.indexOf('@' + next, from) : text.length;
  return text.slice(from, end < 0 ? text.length : end).trim();
}

let _last = null;          // previous sample for rate deltas
let _lastHost = null;
export function getLastHost() { return _lastHost; }

export async function queryHost() {
  let out;
  try {
    out = await runCmd(HOST_CMD);
  } catch (err) {
    console.warn('[host] SSH failure:', err.message);
    return null;
  }
  if (!out || !out.includes('@STAT')) return null;

  const now = Date.now() / 1000;

  // --- disk (/ mount) ---
  const disk = section(out, 'DISK', 'STAT').split(/\s+/);
  // df -B1 / | tail -1 → Filesystem 1B-blocks Used Available Use% Mounted
  const diskTotal = Number(disk[1]) || null;
  const diskUsed  = Number(disk[2]) || null;
  const diskFree  = Number(disk[3]) || null;
  // Match df's Use% (used/(used+available)) which excludes root-reserved blocks,
  // rather than used/total — operators recognise the df figure.
  const diskUsedPct = (diskUsed != null && diskFree != null && diskUsed + diskFree > 0)
    ? (diskUsed / (diskUsed + diskFree)) * 100 : null;

  // --- cpu (jiffies) ---
  const stat = section(out, 'STAT', 'MEM').split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal ...
  const cpuIdle = (stat[3] || 0) + (stat[4] || 0);          // idle + iowait
  const cpuTotal = stat.reduce((a, b) => a + (b || 0), 0);

  // --- memory ---
  const mem = {};
  for (const line of section(out, 'MEM', 'LOAD').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = Number(m[2]) * 1024;                  // kB → bytes
  }
  const memTotal = mem.MemTotal || null;
  const memAvail = mem.MemAvailable || null;
  const memUsedPct = memTotal && memAvail != null ? ((memTotal - memAvail) / memTotal) * 100 : null;
  const swapTotal = mem.SwapTotal || 0;
  const swapUsed = swapTotal ? swapTotal - (mem.SwapFree || 0) : 0;
  const swapUsedPct = swapTotal ? (swapUsed / swapTotal) * 100 : 0;

  // --- load / uptime / cores ---
  const load = section(out, 'LOAD', 'UP').split(/\s+/).map(Number);
  const uptimeSec = Number(section(out, 'UP', 'CORES').split(/\s+/)[0]) || null;
  const cores = Number(section(out, 'CORES', 'NET').trim()) || null;

  // --- network (default interface) ---
  const iface = (section(out, 'IFACE', null).match(/dev\s+(\S+)/) || [])[1] || null;
  let rxBytes = null, txBytes = null;
  if (iface) {
    for (const line of section(out, 'NET', 'IFACE').split('\n')) {
      const m = line.trim().match(new RegExp(`^${iface}:\\s*(.+)`));
      if (m) {
        const f = m[1].trim().split(/\s+/).map(Number);
        rxBytes = f[0];   // receive bytes
        txBytes = f[8];   // transmit bytes
        break;
      }
    }
  }

  // --- rate deltas vs previous scrape ---
  let cpuPct = null, netRxBps = null, netTxBps = null;
  if (_last) {
    const dt = now - _last.t;
    if (dt > 0) {
      const idleD = cpuIdle - _last.cpuIdle;
      const totD = cpuTotal - _last.cpuTotal;
      if (totD > 0) cpuPct = Math.max(0, Math.min(100, (1 - idleD / totD) * 100));
      if (rxBytes != null && _last.rxBytes != null) netRxBps = Math.max(0, (rxBytes - _last.rxBytes) / dt);
      if (txBytes != null && _last.txBytes != null) netTxBps = Math.max(0, (txBytes - _last.txBytes) / dt);
    }
  }
  _last = { t: now, cpuIdle, cpuTotal, rxBytes, txBytes };

  _lastHost = {
    diskTotal, diskUsed, diskFree, diskUsedPct,
    cpuPct, cores,
    memTotal, memAvail, memUsedPct,
    swapTotal, swapUsed, swapUsedPct,
    load1: load[0] ?? null, load5: load[1] ?? null, load15: load[2] ?? null,
    uptimeSec,
    iface, rxBytes, txBytes, netRxBps, netTxBps,
  };
  return _lastHost;
}

export function resetHost() { _last = null; _lastHost = null; }
