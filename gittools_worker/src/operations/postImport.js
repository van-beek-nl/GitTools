/**
 * Updates internal bookkeeping and writes clean meta state. The imported JSON source
 * becomes both the new base tree and the known source tree: record it, advance the base
 * lineage ref, clear any pending refs, and write clean meta.
 * 
 * @param {import('../context.js').Context} ctx
 * @param {object} request
 * @returns {{result: 'clean'}}
 */
function postImport(ctx, request) {
  const { git, meta, log, jsonPath, stateKey } = ctx;

  // The tree Omnis imported FROM (the live source on disk). This is the known source tree, so
  // the next export recognizes it on the fast path.
  const liveTree = git.hashTree(jsonPath);

  // Record a STABLE base. Imports routinely run over uncommitted source (Omnis can only import
  // the whole library at once, so the live JSON usually carries pending work). Pinning that dirty,
  // never-committed live tree as the base produces a base no later export can re-find from history
  // (recovery walks HEAD's committed subtrees), which surfaces as a false "missing base" once the
  // live source drifts. The committed tree at jsonPath is durable and reachable, so use it as the
  // base whenever it exists; only before the first commit of jsonPath does the live tree stand in.
  let baseTree = liveTree;
  if (git.isPathInHead(jsonPath)) {
    baseTree = git.invoke(['rev-parse', `HEAD:${jsonPath}`]);
    if (baseTree !== liveTree) {
      log.info('Imported over uncommitted source; recording the committed tree as the reconciliation base.');
    }
  }

  git.advanceBaseRef(stateKey, baseTree);
  git.deletePendingRefs(stateKey);

  // Record the HEAD commit this import synced against.
  meta.write(meta.getClean(baseTree, liveTree, git.headCommit()));

  return { result: 'clean' };
}

module.exports = { postImport };
