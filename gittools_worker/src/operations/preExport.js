const fs = require('fs');

const { GitToolsError, ErrorCodes } = require('../constants.js');
const { fingerprintPath } = require('../fingerprint.js');

/**
 * Resolves and prepares everything Omnis needs before exporting: a clean source/base pair
 * to merge against, and a cache directory to export into. On success, writes the handoff
 * that post-export will use to finalize meta.
 *
 * @param {import('../context.js').Context} ctx
 * @param {object} request  may carry { allowMissingBase: boolean }
 * @returns {{source: string} | {result: 'missing-base'}}
 *   source = absolute directory Omnis should export into (the cache dir), on success
 *   result = 'missing-base' when the safety gate fires (no handoff written)
 */
function preExport(ctx, request) {
  const { git, handoff, meta, log, jsonPath, jsonAbsolutePath, exportCache, exportCacheIndex } = ctx;

  if (!git.mergeTreeHasWriteTreeCapabilities()) {
    throw new GitToolsError(
      ErrorCodes.MERGE_TREE_UNSUPPORTED,
      'This procedure requires git merge-tree --write-tree (git 2.45 or newer).'
    );
  }

  handoff.clear();

  // We can't assume what needs to be done if the export path contains merge conflicts.
  // If a previous export caused the conflict, it would be safe to overwrite. However,
  // the conflict could be triggered by the user pulling in a colleague's work, in which
  // case GitTools would blindly discard work. The safest fallback is to abort the export
  // and tell the user to resolve the conflict manually first.
  if (git.hasUnresolvedConflicts(jsonPath)) {
    throw new GitToolsError(
      ErrorCodes.UNRESOLVED_CONFLICTS,
      'The JSON path contains unresolved conflicts. Resolve them before exporting.'
    );
  }

  let metaObject = meta.read();
  if (metaObject.status === 'pendingExportConflict') {
    metaObject = resolvePendingConflict(ctx, metaObject);
  }
  meta.write(metaObject);

  const resolved = resolveCurrentSourceAndBase(ctx, metaObject);
  const currentSourceTree = resolved.sourceTree;
  const mergeBase = resolved.mergeBase;
  const liveTree = resolved.liveTree;

  // If the base tree is missing, we don't have a common tree to perform merge operations off of.
  // Applying the export in this state would overwrite any changes with the developer's source.
  // The user should explicitly confirm that they want to proceed with the operation.
  if (!mergeBase && !resolved.perFile && git.isPathInHead(jsonPath) && !request.allowMissingBase) {
    log.warning(`No reconciliation base and '${jsonPath}' differs from this export; refusing to overwrite committed source. Re-run with allowMissingBase to force.`);
    return { result: 'missing-base' };
  }

  // Prepare export directory and index
  fs.mkdirSync(exportCache, { recursive: true });
  if (!fs.existsSync(exportCacheIndex)) {
    git.invoke(['read-tree', '--empty'], { indexFile: exportCacheIndex });
  }

  // Write pending operation to file for the post-export script to use. `liveTree` is the tree
  // currently on disk at the JSON path, paired with a cheap fingerprint of that same content:
  // post-export reuses `liveTree` (skipping an expensive re-hash) only if the fingerprint still
  // matches when it runs, i.e. nothing modified the live path during the export.
  handoff.write({
    op: 'export',
    currentSourceTree: currentSourceTree,
    mergeBase: mergeBase,
    perFileBase: !!resolved.perFile,
    fallbackBase: metaObject.baseTree,
    liveTree: liveTree,
    liveFingerprint: fingerprintPath(jsonAbsolutePath),
  });

  return { source: exportCache };
}

// Called when the previous export left meta in 'pendingExportConflict' state. Leftover dirty edits
// are disposable. Whether the user accepted, discarded, or partly committed the export needs no
// classifying: the export tree is in the base lineage, so the next export's per-file base picks up
// whatever of it reached git.
function resolvePendingConflict(ctx, metaObject) {
  const { git, meta, log, stateKey, jsonPath, jsonAbsolutePath } = ctx;

  log.info('Resolving pending export conflict.');
  if (git.isPathDirty(jsonPath)) {
    log.warning('JSON path has uncommitted changes; discarding before evaluating pending state.');
    // We treat any uncommitted exported code as disposable.
    if (git.doesHeadExist()) {
        // If HEAD exists, we can simply restore from there.
        if (git.isPathInHead(jsonPath)) {
          git.invoke(['restore', '--source=HEAD', '--staged', '--worktree', '--', jsonPath]);
        } else {
          git.invoke(['rm', '-r', '--cached', '--ignore-unmatch', '--', jsonPath]);
          fs.rmSync(jsonAbsolutePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }

        git.invoke(['clean', '-fd', '--', jsonPath]);
    } else {
      // No HEAD to restore from. The pending sourceTree is the pre-export source, so
      // restore the JSON path directly from that tree. Goes through a scratch index
      // rather than the real one, since this can run right after an export merge has
      // left unmerged entries in the real index.
      fs.rmSync(jsonAbsolutePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.mkdirSync(jsonAbsolutePath, { recursive: true });
      git.withScratchIndex((scratch) => {
        scratch.invoke(['read-tree', metaObject.pending.sourceTree]);
        scratch.invoke(['checkout-index', '-a', '-f'], { workTree: jsonAbsolutePath });
      });
    }
  }

  git.deletePendingRefs(stateKey);
  return meta.getClean(metaObject.pending.baseTree, '');
}

// Decides the source side of the export merge and its base: a whole base tree (`mergeBase`), or
// `perFile` when post-export must build one per file against the export (see perFileBase.js).
function resolveCurrentSourceAndBase(ctx, metaObject) {
  const { git, log, jsonPath, stateKey } = ctx;

  const liveTree = git.hashTree(jsonPath);
  if (metaObject.sourceTree && liveTree === metaObject.sourceTree) {
    // Fast path: the live JSON path is still GitTools' own last output (export before
    // commit, repeated export before committing). Use it as the source and the advanced
    // baseTree as the base.
    log.debug('Live JSON path matches last GitTools output; using as source.');
    return { sourceTree: liveTree, mergeBase: metaObject.baseTree, liveTree: liveTree };
  }

  if (git.headCommit()) {
    // The live source is no longer GitTools' last output (a pull, discard, or partial commit moved
    // it). The live edits are disposable; HEAD becomes the source side.
    log.info('Live JSON path has changed since last export; using HEAD as source. Live changes are disposable.');

    // No HEAD entry for jsonPath yet (e.g. before the very first export/import):
    // fall back to the empty tree.
    let sourceTree = git.headSubtree(jsonPath);
    if (!sourceTree) {
      sourceTree = git.withScratchIndex((scratch) => {
        scratch.invoke(['read-tree', '--empty']);
        return scratch.invoke(['write-tree']);
      });
    }

    // Without any record of library output there is nothing to build a base from.
    const hasProvenance = !!metaObject.baseTree || !!git.resolveRef(`refs/gittools/${stateKey}/base`);
    return { sourceTree: sourceTree, mergeBase: '', perFile: hasProvenance, liveTree: liveTree };
  }

  log.debug('Repository has no commits; using live JSON path as source.');
  return { sourceTree: liveTree, mergeBase: metaObject.baseTree, liveTree: liveTree };
}

module.exports = { preExport };
