/**
 * PoolTerminal — Ideal blocks from `cardano-cli query stake-snapshot`.
 *
 * Pure (no Tauri, no SSH) so it can be checked against a captured cli output.
 *
 * Which snapshot: the ledger rotates the three snapshots at every epoch boundary
 * (new -> Mark, Mark -> Set, Set -> Go; cardano-ledger Shelley Rules/Snap.hs),
 * then builds the pool distribution used for slot leadership in the new epoch
 * from SET (Rules/NewEpoch.hs: `pd' = calculatePoolDistr (_pstakeSet ss)`).
 * So:
 *   - stakeSet  = leader election in the CURRENT epoch  <- Ideal uses this
 *   - stakeMark = leader election in the NEXT epoch
 *   - stakeGo   = older snapshot, used for the reward calculation
 * Koios `active_stake` (and so gLiveView and cncli leaderlog) is Set too.
 * Finding D3 in docs/audit/node-11.1.2-compat-2026-09-24.md.
 */

// Expected blocks minted network-wide per epoch, at full decentralisation:
//   epoch_length (432000 slots) × active_slot_coeff (0.05) = 21600  (mainnet)
// A pool's Ideal = σ × this, where σ = poolStakeSet / totalStakeSet.
export const EXPECTED_BLOCKS_PER_EPOCH = 21600;

/**
 * Ideal for the current epoch from parsed stake-snapshot JSON.
 * Returns { sigma, ideal } (ideal rounded to 2 dp); throws if Set is missing.
 *
 * Note: totalStakeSet (~2.1e16) exceeds JS's safe-integer range (2^53 ≈
 * 9.0e15), so JSON.parse rounds it by ~1 lovelace. That's a relative error
 * of ~5e-17 — utterly irrelevant to a value we display to 2 decimal places.
 */
export function idealFromStakeSnapshot(json, poolId) {
  // Nested format (current cardano-cli) first; then the flat keys emitted by
  // cardano-cli 1.35.x (`instance ToJSON Stakes`, cardano-cli/src/Cardano/CLI/Types.hs).
  const poolSet  = json?.pools?.[poolId]?.stakeSet ?? json?.poolStakeSet;
  const totalSet = json?.total?.stakeSet              ?? json?.activeStakeSet;
  if (poolSet == null || totalSet == null || totalSet === 0) {
    throw new Error(`missing stakeSet (pool=${poolSet} total=${totalSet})`);
  }
  const sigma = poolSet / totalSet;
  return { sigma, ideal: Math.round(sigma * EXPECTED_BLOCKS_PER_EPOCH * 100) / 100 };
}
