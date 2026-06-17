const fs = require('fs');
const path = require('path');

const { GitToolsError, ErrorCodes } = require('../constants.js');

/**
 * Finalize an export prepared by pre-export.
 * Runs after Omnis has written the library snapshot into the export cache. It finalizes the
 * export prepared by pre-export: builds the export tree from the cache, reconciles it against
 * the recorded base and the current source, writes the result into the live JSON path, and
 * records the new state (base ref + meta). The handoff is always cleared on the way out.
 * 
 * Outcomes:
 *   - 'clean'        the export was applied, directly or via a clean three-way merge.
 *   - 'conflict'     the three-way merge conflicted; conflict stages are left in the JSON path
 *                    and index, and meta records a pending conflict for the user to resolve.
 *   - 'missing-base' the safety backstop: there is no reconciliation base, applying would
 *                    overwrite committed source that differs from this export, and the caller
 *                    did not pass allowMissingBase. Nothing is applied.
 *
 * @param {import('../context.js').Context} ctx
 * @param {object} request  may carry { allowMissingBase: boolean } to confirm a forced
 *                          overwrite after a previous 'missing-base' result.
 * @returns {{result: 'clean' | 'conflict' | 'missing-base'}}
 */
function postExport(ctx, request) {
  const { allowMissingBase } = request;
  const { log, git, meta, handoff, jsonPath, stateRoot, stateKey } = ctx;
  
  const pendingOperation = handoff.read();
  if (!pendingOperation || pendingOperation.op !== 'export') {
    throw new GitToolsError(ErrorCodes.NO_PENDING_EXPORT, 'No pending export to finalize. Run pre-export first.');
  }

  const { currentSourceTree, mergeBase } = pendingOperation; 
  const exportDirectory = path.join(stateRoot, 'export-cache');
  const exportIndex = `${exportDirectory}.index`;
  
  try {
    // Build the export tree incrementally against the persistent cache index: --refresh
    // updates the index's stat cache so hashTree's diff against the on-disk cache is accurate
    // (and is repeated afterwards to leave the index clean for the next export). The cache and
    // its index live in the per-worktree state dir, so this is the worktree's own export.
    const gitOpts = { indexFile: exportIndex, workTree: exportDirectory };
    git.invokeRaw(['update-index', '-q', '--refresh'], gitOpts);
    const exportTree = git.hashTree(null, gitOpts);
    git.invokeRaw(['update-index', '-q', '--refresh'], gitOpts);
    log.debug(`Export tree: ${exportTree}`);

    // No reconciliation base: a genuine first export, or the base was lost. There is nothing
    // to merge against, so apply directly unless that would overwrite committed source that
    // differs from this export.
    if (!mergeBase) {
      const overwritesCommitted = git.isPathInHead(jsonPath) && git.invoke(['rev-parse', `HEAD:${jsonPath}`]) !== exportTree;

      if (overwritesCommitted && !allowMissingBase) {
        log.warning(`No reconciliation base and '${jsonPath}' differs from this export; refusing to overwrite committed source.`);
        return { result: 'missing-base' };
      }

      if (overwritesCommitted) {
        log.warning(`No reconciliation base exists; forcing overwrite of the committed source at '${jsonPath}' (allowMissingBase set).`);
        log.warning('If your peers advanced this source, review the diff before committing.');
      } else {
        log.info('No base tree exists yet; applying export directly.');
      }

      applyTreeToLiveJsonPath(ctx, exportTree);
      const finalSourceTree = git.hashTree(jsonPath);
      git.advanceBaseRef(stateKey, exportTree);
      meta.write(meta.getClean(exportTree, finalSourceTree));
      return { result: 'clean' };
    }

    // Source has not moved since the recorded base: nothing to reconcile, apply directly.
    if (currentSourceTree === mergeBase) {
      log.info('Current source equals base tree; applying export directly.');
      applyTreeToLiveJsonPath(ctx, exportTree);
      const finalSourceTree = git.hashTree(jsonPath);
      git.advanceBaseRef(stateKey, exportTree);
      meta.write(meta.getClean(exportTree, finalSourceTree));
      return { result: 'clean' };
    }

    // Source diverged from the base: three-way merge the export (exportTree) onto the current
    // source (currentSourceTree) using the recorded base (mergeBase) as the common ancestor.
    log.info('Current source differs from base tree; running merge.');
    const mergeResult = git.mergeTree(mergeBase, currentSourceTree, exportTree);
    if (mergeResult.status === 0) {
      log.info('Merge succeeded.');
      // Write the merged tree, but record the raw exportTree as the new base (not the merged
      // result): the base tracks what the library produced, while sourceTree tracks what is
      // actually on disk. After a merge those differ, and preExport relies on that distinction
      // to recognize its own last output on the next export.
      applyTreeToLiveJsonPath(ctx, mergeResult.resultTree);
      const finalSourceTree = git.hashTree(jsonPath);
      git.advanceBaseRef(stateKey, exportTree);
      meta.write(meta.getClean(exportTree, finalSourceTree));
      return { result: 'clean' };
    }

    log.info('Merge completed with conflicts; applying conflicted result to live JSON path.');
    applyConflictedMergeToLiveJsonPath(ctx, mergeResult);
    git.setPendingRefs(stateKey, currentSourceTree, exportTree);
    meta.write(meta.getPending(mergeBase, currentSourceTree, exportTree));
    log.warning('Export completed with conflicts. Resolve the JSON path with your Git client.');
    return { result: 'conflict' };
  } finally {
    handoff.clear();
  }
}

/**
 * Make the live JSON path on disk match `exportTree`, writing only the delta and leaving the
 * user's staging intact. A no-op when the path already equals the tree (the common
 * repeated-export-of-identical-content case).
 *
 * @param {import('../context.js').Context} ctx
 * @param {string} exportTree  tree SHA the JSON path should contain
 */
function applyTreeToLiveJsonPath(ctx, exportTree) {
  const { git, jsonPath } = ctx;

  const liveTree = git.hashTree(jsonPath);
  if (liveTree === exportTree) {
    return;
  }

  const changes = writeLiveJsonPathDelta(ctx, exportTree, liveTree);
  resetStagedChanges(ctx, changes);
}

/**
 * Apply a conflicted three-way merge to the live JSON path. Two parts: write merge-tree's
 * best-effort result tree to disk (so the user sees the merged content with conflict markers),
 * then reproduce in the real index the unmerged entries merge-tree reported, so the conflict
 * shows up as `UU` in `git status` and resolves with a normal Git client.
 *
 * @param {import('../context.js').Context} ctx
 * @param {object} mergeResult  from git.mergeTree: { resultTree, lines, ... }
 */
function applyConflictedMergeToLiveJsonPath(ctx, mergeResult) {
  const { git, jsonPath } = ctx;

  if (!mergeResult.resultTree) {
    throw new GitToolsError(ErrorCodes.NO_MERGE_TREE, 'merge-tree did not return a result tree.');
  }

  const liveTree = git.hashTree(jsonPath);
  const changes = writeLiveJsonPathDelta(ctx, mergeResult.resultTree, liveTree);
  resetStagedChanges(ctx, changes);

  // Parse merge-tree's conflicted-file records ("<mode> <oid> <stage>\t<path>") into the
  // unmerged stage 1/2/3 entries to stage, prefixing each path back under the JSON path.
  const stageLines = [];
  const conflictingPaths = new Set();
  for (const line of mergeResult.lines) {
    const rxResult = /^(\d{6}) ([0-9a-fA-F]{40,64}) ([123])\t(.+)$/.exec(line);
    if (!rxResult) {
      continue;
    }

    const [, mode, objectId, stage, rawPath] = rxResult;
    const prefixedPath = jsonPath === '.' ? rawPath : `${jsonPath}/${rawPath}`;
    conflictingPaths.add(prefixedPath);
    stageLines.push(`${mode} ${objectId} ${stage}\t${prefixedPath}`);
  }

  // Drop the existing stage-0 entry for each conflicting path first (one batched call), then
  // add the unmerged stages. --index-info cannot add stage 1/2/3 over a surviving stage-0
  // entry, so the force-remove must happen first.
  if (conflictingPaths.size > 0) {
    git.invoke(['update-index', '--force-remove', '--stdin'], {
      input: [...conflictingPaths].join('\n') + '\n'
    });
  }

  if (stageLines.length > 0) {
    git.invoke(['update-index', '--index-info'], {
      input: stageLines.join('\n') + '\n'
    });
  }
}

/**
 * Write onto disk the difference between the live JSON path (`liveTree`) and a target `tree`:
 * delete the files the target drops (pruning parent dirs that become empty), and check out the
 * files it adds or changes. Only changed paths are touched, so unchanged files keep their
 * mtime and the working tree is disturbed as little as possible.
 *
 * @param {import('../context.js').Context} ctx
 * @param {string} tree      target tree SHA to bring the JSON path to
 * @param {string} liveTree  tree SHA of the JSON path's current on-disk content
 * @returns {string[]} the repo-relative paths that changed (consumed by resetStagedChanges)
 */
function writeLiveJsonPathDelta(ctx, tree, liveTree) {
  const { git, jsonPath, jsonAbsolutePath } = ctx;

  const nameStatus = git.invoke(['diff-tree', '-r', '--no-commit-id', '--name-status', liveTree, tree]);
  if (!nameStatus) return [];

  const writes = [];   // paths added/modified by `tree`, to check out
  const changed = [];  // every changed path (repo-relative), for the caller

  for (const line of nameStatus.split(/\r?\n/).filter(Boolean)) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const status = line.slice(0, tab);
    const rel = line.slice(tab + 1);
    changed.push(jsonPath === '.' ? rel : `${jsonPath}/${rel}`);
    if (status.startsWith('D')) {
      // Deleted by the target: remove the file, then walk up removing each parent directory
      // that is now empty, stopping at the JSON root (or if we ever step outside it, or hit a
      // non-empty/unreadable dir). This keeps the tree free of empty folders left by deletes.
      const abs = path.join(jsonAbsolutePath, rel);
      fs.rmSync(abs, { force: true });
      const absRoot = path.resolve(jsonAbsolutePath);
      let dir = path.dirname(abs);
      while (dir) {
        const full = path.resolve(dir);
        if (full === absRoot || !full.startsWith(absRoot)) break;
        let entries;
        try { entries = fs.readdirSync(full); } catch { break; }
        if (entries.length !== 0) break;
        try { fs.rmdirSync(full); } catch { break; }
        dir = path.dirname(dir);
      }
    } else {
      writes.push(rel);
    }
  }

  // Check out the added/modified files from `tree` via a throwaway index, so the real index
  // (the user's staging) is never touched. Paths are relative to the tree, written under the
  // JSON path via GIT_WORK_TREE.
  if (writes.length > 0) {
    fs.mkdirSync(jsonAbsolutePath, { recursive: true });
    git.withScratchIndex((scratch) => {
      scratch.invoke(['read-tree', tree]);
      scratch.invoke(['checkout-index', '-f', '--stdin'], {
        workTree: jsonAbsolutePath,
        input: writes.join('\n') + '\n',
      });
    });
  }

  return changed;
}

/**
 * Keep the applied delta out of the index: reset to HEAD any changed path that ended up
 * staged, so the export surfaces as unstaged working-tree edits the user reviews and stages
 * deliberately. Paths the user staged themselves but that this export did not change are left
 * untouched. No-op when there is no HEAD to reset against.
 *
 * @param {import('../context.js').Context} ctx
 * @param {string[]} changes  repo-relative paths written by writeLiveJsonPathDelta
 */
function resetStagedChanges(ctx, changes) {
  const { git, jsonPath } = ctx;

  if (!changes || changes.length === 0) {
    return;
  }

  if (!git.doesHeadExist()) {
    return;
  }

  const staged = git.invoke(['diff', '--cached', '--name-only', '--', jsonPath]);
  if (!staged) {
    return
  }

  const stagedSet = new Set(staged.split(/\r?\n/).filter(Boolean));
  const pathsToReset = changes.filter(path => stagedSet.has(path));
  if (pathsToReset.length === 0) {
    return;
  }

  git.invoke(['restore', '--staged', '--source=HEAD', '--pathspec-from-file=-', '--'], {
    input: pathsToReset.join('\n') + '\n'
  })
}

module.exports = { postExport };
