/**
 * PoolTerminal — Data Source Contract
 * ===================================
 * Both LiveDataSource (live.js) and DemoDataSource (demo.js) implement this
 * interface. Views ONLY talk to the router (index.js) — never to live or demo
 * directly. The router decides which backend is active (LIVE / DEMO).
 *
 * All methods are async (return Promises) so the live backend can do SSH /
 * Koios / cache I/O behind the same interface the demo backend satisfies
 * instantly.
 *
 * Shapes (documented as JSDoc typedefs — this module emits no runtime code):
 *
 * @typedef {Object} PoolIdentity
 * @property {string} ticker
 * @property {string} poolId      bech32 pool id
 * @property {string} poolIdHex
 *
 * @typedef {Object} BlockProduction       // this epoch
 * @property {number} leader      total slots assigned this epoch
 * @property {number} ideal       mathematically ideal blocks for stake
 * @property {number} luckPercent
 * @property {number} adopted     blocks successfully made so far
 * @property {number} confirmed
 * @property {number} lost
 *
 * @typedef {Object} PoolPulse
 * @property {number} score       0..100 composite (see DESIGN.md §11)
 * @property {number} delta       change vs previous reading
 * @property {Object} components  keyed component scores
 *
 * @typedef {Object} NowSnapshot
 * @property {string}  poolTicker
 * @property {number}  epoch
 * @property {number}  epochProgress        0..1
 * @property {number}  slot                 absolute slot
 * @property {number}  slotInEpoch
 * @property {number}  syncPercent
 * @property {boolean} atTip
 * @property {number}  kesDaysRemaining
 * @property {number}  kesPeriodsRemaining
 * @property {number}  peersIn
 * @property {number}  peersOut
 * @property {boolean} forging
 * @property {BlockProduction} blockProduction
 * @property {PoolPulse}       poolPulse
 *
 * @typedef {Object} UpcomingBlock
 * @property {number} index
 * @property {number} slot
 * @property {number} etaSeconds
 *
 * @typedef {Object} ChainDensity
 * @property {number} m5
 * @property {number} h1
 * @property {number} h24
 * @property {number} d7
 * @property {number} epoch
 *
 * @typedef {Object} WindowStats
 * @property {number} avgSeconds
 * @property {number} maxSeconds
 * @property {number} minSeconds
 *
 * @typedef {Object} ChainPulse
 * @property {number}   sinceLastBlockSeconds   informational — NEVER colour-coded red
 * @property {boolean}  atTip                   the actual health signal
 * @property {number}   tipBlock
 * @property {number[]} recentBlockTimes        unix ts of recent arrivals (heartbeat)
 * @property {WindowStats}  windowStats
 * @property {ChainDensity} density
 *
 * @typedef {Object} MempoolTx
 * @property {string} hash
 * @property {number} bytes
 *
 * @typedef {Object} Mempool
 * @property {number} txCount
 * @property {number} totalBytes
 * @property {MempoolTx[]} recent
 *
 * The DataSource interface (both backends provide all of these):
 *   getPoolIdentity()   -> Promise<PoolIdentity>
 *   getNowSnapshot()    -> Promise<NowSnapshot>
 *   getUpcomingBlocks() -> Promise<UpcomingBlock[]>
 *   getChainPulse()     -> Promise<ChainPulse>
 *   getMempool()        -> Promise<Mempool>
 *
 * Future phases extend this contract with HISTORY / DELEGATORS / NODE HEALTH /
 * REWARDS / GOVERNANCE / MAP methods. Adding a method means implementing it in
 * BOTH demo.js and live.js.
 */

export {}; // documentation-only module
