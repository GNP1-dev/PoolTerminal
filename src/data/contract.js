/**
 * PoolTerminal — Data Source Contract
 * ===================================
 * Both LiveDataSource (live.js) and DemoDataSource (demo.js) implement this
 * interface. Views ONLY talk to the router (index.js).
 *
 * Shapes (JSDoc typedefs — no runtime code):
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
 * Density windows (blocks ÷ slots over each window — ~5% healthy on mainnet):
 *   short windows (m1, m5, m20) are useful — noisy enough to actually move
 *   long windows (h1, d1, epoch) almost always sit on 5% — kept for reference
 *
 * @typedef {Object} ChainDensity
 * @property {number} m1
 * @property {number} m5
 * @property {number} m20
 * @property {number} h1
 * @property {number} d1
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
 * @property {number[]} recentBlockTimes        unix ts of arrivals over last ~1 hour
 *                                              (heartbeat tabs select a sub-window)
 * @property {WindowStats}  windowStats         reference; the renderer recomputes
 *                                              stats from the selected heartbeat window
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
 */

export {}; // documentation-only module
