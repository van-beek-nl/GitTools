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

  // The base is the tree the library now holds, which is the tree Omnis just imported FROM. That
  // has to be `liveTree`, uncommitted or not. Recording anything else makes meta claim the library
  // is at a state it has never been at, and the next export pays for it: post-export three-way
  // merges (base, source = this same live tree, export), so a base the library never held turns
  // the developer's own uncommitted work into a competing edit present on BOTH sides. Every
  // re-export over it then conflicts — the daily "export, change something, export again" loop.
  //
  // Imports routinely run over uncommitted source: Omnis imports the whole library at once, so the
  // live JSON usually carries an export that has not been committed yet.
  if (git.isPathInHead(jsonPath)) {
    const committedTree = git.invoke(['rev-parse', `HEAD:${jsonPath}`]);
    if (committedTree !== liveTree) {
      // The live tree never reaches HEAD's history, so per-file bases can only match the committed
      // versions it was built on. Same reasoning as post-export anchoring the source it overwrites.
      log.info('Imported over uncommitted source; anchoring the committed tree in the base lineage.');
      git.advanceBaseRef(stateKey, committedTree);
    }
  }

  const baseTree = liveTree;
  git.advanceBaseRef(stateKey, baseTree);
  git.deletePendingRefs(stateKey);

  meta.write(meta.getClean(baseTree, liveTree));

  return { result: 'clean' };
}

module.exports = { postImport };
