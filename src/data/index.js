/**
 * PoolTerminal — data source router.
 *
 * The single point every view imports. Holds the current mode (LIVE / DEMO) and
 * returns the active data source. Views call e.g.:
 *
 *     import { dataSource } from './data/index.js';
 *     const snap = await dataSource().getNowSnapshot();
 *
 * Default mode is DEMO — the app shows synthetic data until a real connection is
 * configured. The tickertape LIVE / DEMO badge flips the mode via setMode().
 */

import { DemoDataSource } from './demo.js';
import { LiveDataSource } from './live.js';

let _mode = 'demo';
const _demo = new DemoDataSource();
const _live = new LiveDataSource();

export function getMode() {
  return _mode;
}

export function setMode(mode) {
  if (mode !== 'live' && mode !== 'demo') {
    throw new Error(`invalid mode: ${mode}`);
  }
  _mode = mode;
  return _mode;
}

/** The active data source (demo or live) implementing the contract. */
export function dataSource() {
  return _mode === 'live' ? _live : _demo;
}
