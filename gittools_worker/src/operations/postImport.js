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
  const { git, meta, jsonPath, stateKey } = ctx;

  const currentSourceTree = git.hashTree(jsonPath);

  git.advanceBaseRef(stateKey, currentSourceTree);
  git.deletePendingRefs(stateKey);

  meta.write(meta.getClean(currentSourceTree, currentSourceTree));
  
  return { result: 'clean' };
}

module.exports = { postImport };
