const fs = require('fs');

/**
 * Empties this library's export cache so the next export regenerates the whole library.
 *
 * Omnis' $exportjson updates an existing JSON tree in place, rewriting only the classes it
 * considers changed. That incremental behaviour is what makes repeated exports fast, but it means
 * the export tree is "what Omnis wrote this run" layered over whatever the cache already held. If
 * the cache goes stale in a way Omnis cannot see — most often because it exported a class whose
 * edit had not been committed to the class in the IDE yet — every subsequent export reproduces the
 * same wrong tree, and re-exporting never clears it. An empty cache makes every class 'new' to
 * Omnis, so the next export writes the library out in full.
 *
 * This is a manual escape hatch, never triggered automatically. Nothing GitTools can check
 * distinguishes a stale cache entry from a correct one (the class is present, just wrong), so the
 * decision belongs to the developer who can see that their change is not coming out.
 *
 * Deliberately narrow: it removes ONLY the cache directory and its index. meta.json (the recorded
 * base / source / sync state) and pending-op.json (an in-flight export handoff) live in the same
 * state directory and are reconciliation state, not build output — deleting those would lose the
 * record of what git and the library last agreed on. The base lineage is a ref, so it is never in
 * scope here either way.
 *
 * Safe to run at any point, including with an export conflict pending: the cache is a pure build
 * artifact, so the worst outcome is one slow export.
 *
 * @param {import('../context.js').Context} ctx
 * @param {object} request
 * @returns {{result: 'clean', cleared: string[]}} the paths that existed and were removed
 */
function clearExportCache(ctx, request) {
  const { log, exportCache, exportCacheIndex } = ctx;

  const cleared = [];
  for (const target of [exportCache, exportCacheIndex]) {
    if (!fs.existsSync(target)) {
      continue;
    }

    // maxRetries covers a virus scanner or indexer briefly holding a file open on Windows, the
    // same reason the other destructive paths in the worker use it.
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    cleared.push(target);
  }

  if (cleared.length === 0) {
    log.info('No export cache to clear; the next export rebuilds the library in full regardless.');
  } else {
    log.info(`Cleared the export cache (${cleared.length} path(s)); the next export rebuilds the library in full.`);
  }

  return { result: 'clean', cleared: cleared };
}

module.exports = { clearExportCache };
