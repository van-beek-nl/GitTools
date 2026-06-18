const fs = require('fs');
const path = require('path');

const { GitToolsError, ErrorCodes } = require('../constants.js');
const { fingerprintPath } = require('../fingerprint.js');

const FAST_HISTORY_MAX_COMMITS = 1000;
const FULL_HISTORY_MAX_COMMITS = 2147483647;

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
  const { git, handoff, meta, log, jsonPath, jsonAbsolutePath, stateRoot } = ctx;

  if (!git.mergeTreeHasWriteTreeCapabilities()) {
    throw new GitToolsError(
      ErrorCodes.MERGE_TREE_UNSUPPORTED,
      'This procedure requires git merge-tree --write-tree (git 2.38 or newer).'
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
  if (!mergeBase && git.isPathInHead(jsonPath) && !request.allowMissingBase) {
    log.warning(`No reconciliation base and '${jsonPath}' differs from this export; refusing to overwrite committed source. Re-run with allowMissingBase to force.`);
    return { result: 'missing-base' };
  }

  // Prepare export directory and index
  const exportDirectory = path.join(stateRoot, 'export-cache');
  const exportIndex = `${exportDirectory}.index`;
  fs.mkdirSync(exportDirectory, { recursive: true });
  if (!fs.existsSync(exportIndex)) {
    git.invoke(['read-tree', '--empty'], { indexFile: exportIndex });
  }

  // Write pending operation to file for the post-export script to use. `liveTree` is the tree
  // currently on disk at the JSON path, paired with a cheap fingerprint of that same content:
  // post-export reuses `liveTree` (skipping an expensive re-hash) only if the fingerprint still
  // matches when it runs, i.e. nothing modified the live path during the export.
  handoff.write({
    op: 'export',
    currentSourceTree: currentSourceTree,
    mergeBase: mergeBase,
    liveTree: liveTree,
    liveFingerprint: fingerprintPath(jsonAbsolutePath),
  });

  return { source: exportDirectory };
}

function splitLines(string) {
  return string.split(/\r?\n/).filter(line => line.trim() !== '');
}

// Called when the previous export left meta in 'pendingExportConflict' state: export wrote
// conflict markers into the JSON path and stopped without finalizing meta, leaving the user
// to either resolve the conflict (accepting the export) or discard it. This discards any
// leftover dirty edits, then classifies which of the two happened and returns clean meta
// reflecting the outcome.
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

  const currentSourceTree = git.hashTree(jsonPath);
  if (currentSourceTree === metaObject.pending.sourceTree) {
    // The current source tree matches pending.sourceTree, which means
    // that nothing changed compared to the old situation. We can safely
    // assume the old base can be re-used.
    log.info('Pending conflict was discarded; keeping previous base tree.');
    git.deletePendingRefs(stateKey);
    return meta.getClean(metaObject.pending.baseTree, currentSourceTree);
  }

  // The current source tree differs from pending.sourceTree. This can mean two things:
  // 1) The user manually resolved the conflicts and committed the result. The new tree
  //    contains the export's content, just merged by hand instead of by git.
  // 2) The discard step above restored the JSON path to HEAD or some other unrelated state.
  //    It differs, but not because the user resolved the merge.
  //
  // GitTools needs a way to distinguish these two situations. We do so by replaying
  // the exact same 3-way merge that originally conflicted:
  // - If the replay is clean, it's proof that the current source tree already contains
  //   everything the export wanted. `exportTree` becomes the new base and `currentSourceTree`
  //   becomes the new source. This prevents the next export from raising unexpected conflicts.
  // - If the replay conflicts, the current source tree does *not* contain the export's changes.
  //   Here, we should not treat the `exportTree` as new base. If we did, a future export would
  //   silently discard work without conflicts or warnings.
  const replay = git.mergeTree(
    metaObject.pending.baseTree,
    currentSourceTree,
    metaObject.pending.exportTree
  );
  git.deletePendingRefs(stateKey);
  if (replay.status === 0) {
    // Replay is clean, we can safely advance the base ref
    log.info('Pending conflict was resolved and accepted; advancing base to export tree.');
    git.advanceBaseRef(stateKey, metaObject.pending.exportTree);
    return meta.getClean(metaObject.pending.exportTree, currentSourceTree);
  }

  // Replay was *not* clean, reset the meta file to force the next export to recompute
  // the merge base from history instead.
  log.warning('Pending conflict was not absorbed by the current source; dropping continuation base. The next export will recompute the merge base from HEAD.');
  return meta.getClean('', '');
}

// Decides the source side of the export merge and the base to merge it against.
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

  if (git.doesHeadExist()) {
    // Fallback path: the live source is no longer GitTools' last output, so a pull,
    // discard, or partial commit moved it. The live edits are disposable; HEAD becomes
    // the source side. The advanced baseTree is now unreliable, so the base is recomputed
    // as the true common ancestor from HEAD's history. An empty base there means no
    // recorded ancestor is reachable; the export then applies as if it had no base, with
    // the overwrite warning.
    log.info('Live JSON path has changed since last export; using HEAD as source. Live changes are disposable.');
    const baseRefName = `refs/gittools/${stateKey}/base`;
    let lineage = [];
    if (git.resolveRef(baseRefName)) {
      const lineageResult = git.invokeRaw(['rev-list', '--format=%T', '--no-commit-header', baseRefName]);
      if (lineageResult.status === 0) {
        lineage = splitLines(lineageResult.stdout);
      }
    }
    const lineageSet = new Set(lineage);

    let mergeBase = findRecordedBaseInHistory(ctx, metaObject, lineageSet, FAST_HISTORY_MAX_COMMITS);
    if (!mergeBase && lineage.length > 0) {
      log.info(`No recorded base within the last ${FAST_HISTORY_MAX_COMMITS} commits; extending search to full history.`);
      mergeBase = findRecordedBaseInHistory(ctx, metaObject, lineageSet, FULL_HISTORY_MAX_COMMITS);
    }

    // No HEAD entry for jsonPath yet (e.g. before the very first export/import):
    // fall back to the empty tree.
    let sourceTree;
    if (git.isPathInHead(jsonPath)) {
      sourceTree = git.invoke(['rev-parse', `HEAD:${jsonPath}`]);
    } else {
      sourceTree = git.withScratchIndex((scratch) => {
        scratch.invoke(['read-tree', '--empty']);
        return scratch.invoke(['write-tree']);
      });
    }

    return { sourceTree: sourceTree, mergeBase: mergeBase, liveTree: liveTree };
  }

  log.debug('Repository has no commits; using live JSON path as source.');
  return { sourceTree: liveTree, mergeBase: metaObject.baseTree, liveTree: liveTree };
}

// Matches HEAD's jsonPath subtree history (newest first, up to maxCommits commits) against
// the bases GitTools has recorded (lineageSet), returning the base tree to merge against, or
// '' if none is found within that window.
function findRecordedBaseInHistory(ctx, metaObject, lineageSet, maxCommits) {
  const { git, log, jsonPath } = ctx;

  // --full-history keeps commits that history simplification would prune on the side of a
  // merge, so a base recorded only on a merged-in branch is still found.
  const result = git.invokeRaw(['rev-list', '--full-history', `--max-count=${maxCommits}`, 'HEAD', '--', jsonPath]);
  let headTrees = [];
  if (result.status === 0) {
    const commits = splitLines(result.stdout);
    if (commits.length > 0) {
      const queries = commits.map((commit) => `${commit}:${jsonPath}`);
      for (const line of git.catFileBatchCheck(queries)) {
        const fields = line.trim().split(' ');
        if (fields.length >= 2 && fields[1] === 'tree') {
          headTrees.push(fields[0]);
        }
      }
    }
  }

  // Clean-merge handoff case: GitTools' last produced source is reachable from HEAD even
  // though the recorded baseTree is the raw export tree, not the merged source tree.
  // baseTree is still the correct library-side base.
  if (metaObject.sourceTree && metaObject.baseTree && headTrees.includes(metaObject.sourceTree)) {
    log.debug('Last GitTools-produced source is reachable from HEAD; using its recorded base tree.');
    return metaObject.baseTree;
  }

  // Otherwise, the true common ancestor: the most recent commit (newest first) whose subtree
  // GitTools recorded as a base (an import or accepted export). The match is by subtree id,
  // so it is unaffected by which commit last carried that subtree.
  for (const subTree of headTrees) {
    if (lineageSet.has(subTree)) {
      return subTree;
    }
  }

  return '';
}

module.exports = { preExport };
