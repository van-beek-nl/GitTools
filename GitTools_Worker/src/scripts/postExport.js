// Post-export phase. PORT of scripts_proto/post-export.ps1.
//
// Responsibilities (to implement):
//   - read the handoff (currentSourceTree, mergeBase); error if absent.
//   - build the export tree incrementally from the cache + its stat-index.
//   - no base: apply directly, OR the MISSING-BASE BACKSTOP (refuse to overwrite
//     committed source without allowMissingBase -> { result: 'missing-base' }).
//   - base == source: apply directly.
//   - otherwise three-way merge-tree; clean -> apply merged result; conflict -> apply the
//     conflicted result, set pending refs + pending meta.
//   - update durability refs + metadata; always clear the handoff (keep the cache warm).

const fs = require('fs');
const path = require('path');

const { GitToolsError, ErrorCodes } = require('../constants.js');

// post-export -> { result: 'clean' | 'conflict' | 'missing-base' }

/**
 * @param {import('../context.js').Context} ctx
 * @param {object} request  may carry { allowMissingBase: boolean }
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
    const gitOpts = { indexFile: exportIndex, workTree: exportDirectory };
    git.invokeRaw(['update-index', '-q', '--refresh'], gitOpts);
    const exportTree = git.hashTree(null, gitOpts);
    git.invokeRaw(['update-index', '-q', '--refresh'], gitOpts);
    log.debug(`Export tree: ${exportTree}`);

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

    if (currentSourceTree === mergeBase) {
      log.info('Current source equals base tree; applying export directly.');
      applyTreeToLiveJsonPath(ctx, exportTree);
      const finalSourceTree = git.hashTree(jsonPath);
      git.advanceBaseRef(stateKey, exportTree);
      meta.write(meta.getClean(exportTree, finalSourceTree));
      return { result: 'clean' };
    }

    log.info('Current source differs from base tree; running merge.');
    const mergeResult = git.mergeTree(mergeBase, currentSourceTree, exportTree);
    if (mergeResult.status === 0) {
      log.info('Merge succeeded.');
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

function applyTreeToLiveJsonPath(ctx, exportTree) {
  const { git, jsonPath } = ctx;

  const liveTree = git.hashTree(jsonPath);
  if (liveTree === exportTree) {
    return;
  }

  const changes = writeLiveJsonPathDelta(ctx, exportTree, liveTree);
  resetStagedChanges(ctx, changes);
}

function applyConflictedMergeToLiveJsonPath(ctx, mergeResult) {
  const { git, jsonPath } = ctx;

  if (!mergeResult.resultTree) {
    throw new GitToolsError(ErrorCodes.NO_MERGE_TREE, 'merge-tree did not return a result tree.');
  }

  const liveTree = git.hashTree(jsonPath);
  const changes = writeLiveJsonPathDelta(ctx, mergeResult.resultTree, liveTree);
  resetStagedChanges(ctx, changes);

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

function writeLiveJsonPathDelta(ctx, tree, liveTree) {
  const { git, jsonPath, jsonAbsolutePath } = ctx;

  const nameStatus = git.invoke(['diff-tree', '-r', '--no-commit-id', '--name-status', liveTree, tree]);
  if (!nameStatus) return [];

  const writes = [];
  const changed = [];

  for (const line of nameStatus.split(/\r?\n/).filter(Boolean)) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const status = line.slice(0, tab);
    const rel = line.slice(tab + 1);
    changed.push(jsonPath === '.' ? rel : `${jsonPath}/${rel}`);
    if (status.startsWith('D')) {
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
