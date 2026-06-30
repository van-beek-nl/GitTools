const fs = require('fs');
const path = require('path');

const { GitToolsError, ErrorCodes } = require('../constants.js');
const { fingerprintPath } = require('../fingerprint.js');

// JSON keys Omnis rewrites on every export — and even on merely opening and closing a class in
// the IDE — whose values carry no meaning for import. Left alone they change constantly, producing
// noise diffs, spurious merge conflicts, and needless base advances. cleanExportTree reverts
// them to the source's value before the export enters reconciliation.
const IRRELEVANT_KEYS = ['moddate', 'internalversion'];

// Git's mode for a regular (non-executable) file, used when writing index records by hand.
const FILE_MODE_REGULAR = '100644';

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
 *
 * @param {import('../context.js').Context} ctx
 * @param {object} request  may carry { cleanIrrelevantKeys: boolean } to revert the import-irrelevant keys
 *                          (off unless explicitly set; see cleanExportTree).
 * @returns {{result: 'clean' | 'conflict' | 'missing-base'}}
 */
function postExport(ctx, request) {
  const { cleanIrrelevantKeys } = request;
  const { log, git, meta, handoff, jsonPath, jsonAbsolutePath, stateRoot, stateKey } = ctx;

  const pendingOperation = handoff.read();
  if (!pendingOperation || pendingOperation.op !== 'export') {
    throw new GitToolsError(ErrorCodes.NO_PENDING_EXPORT, 'No pending export to finalize. Run pre-export first.');
  }

  const { currentSourceTree, mergeBase, liveTree, liveFingerprint } = pendingOperation;
  const exportDirectory = path.join(stateRoot, 'export-cache');
  const exportIndex = `${exportDirectory}.index`;

  // The HEAD commit this export is reconciled against, recorded with the resulting meta.
  const syncCommit = git.headCommit();

  // Hashing the live JSON path is one of the most expensive steps (a full untracked-file scan),
  // and applyTreeToLiveJsonPath needs that tree to compute its delta. Pre-export already hashed
  // it and recorded a cheap fingerprint of the same content; reuse the recorded tree when the
  // fingerprint still matches, i.e. nothing touched the live path during the export. On any
  // mismatch (or an older handoff without these fields) leave it null and let apply re-hash.
  let knownLiveTree;
  if (liveTree == null || liveFingerprint == null) {
    knownLiveTree = null;
  } else if (fingerprintPath(jsonAbsolutePath) !== liveFingerprint) {
    log.info('Live JSON path changed since pre-export; re-hashing it instead of reusing the recorded tree.');
    knownLiveTree = null;
  } else {
    knownLiveTree = liveTree;
  }

  try {
    // Build the export tree incrementally against the persistent cache index: --refresh
    // updates the index's stat cache so hashTree's diff against the on-disk cache is accurate
    // (and is repeated afterwards to leave the index clean for the next export). The cache and
    // its index live in the per-worktree state dir, so this is the worktree's own export.
    const gitOpts = { indexFile: exportIndex, workTree: exportDirectory };
    git.invokeRaw(['update-index', '-q', '--refresh'], gitOpts);
    let exportTree = git.hashTree(null, gitOpts);
    log.debug(`Export tree: ${exportTree}`);

    // Optionally neutralize the import-irrelevant keys (IRRELEVANT_KEYS) before reconciliation,
    // reverting them to the source's values. Doing this up front keeps the whole pipeline
    // noise-free: the merge, the recorded base, and the written-back working tree all operate on
    // a scrubbed tree.
    if (cleanIrrelevantKeys) {
      exportTree = cleanExportTree(ctx, exportDirectory, currentSourceTree, exportTree);
    }

    // No reconciliation base: a genuine first export, or the base was lost. There is nothing
    // to merge against, so apply directly unless that would overwrite committed source that
    // differs from this export.
    if (!mergeBase) {
      const committedTree = git.headSubtree(jsonPath);
      const overwritesCommitted = committedTree !== '' && committedTree !== exportTree;

      if (overwritesCommitted) {
        log.warning(`No reconciliation base exists; forcing overwrite of the committed source at '${jsonPath}'.`);
        log.warning('If your peers advanced this source, review the diff before committing.');
        // Anchor the committed source we are about to overwrite into the base lineage. Export-only
        // workflows (the library was never GitTools-imported) otherwise plant no findable base, so a
        // later export that returns to this committed state — e.g. after discarding uncommitted work —
        // would raise another false missing-base. Recording it makes that state recoverable; it does
        // not change what we write now (still exportTree), only what a future export can merge against.
        git.advanceBaseRef(stateKey, committedTree);
      } else {
        log.info('No base tree exists yet; applying export directly.');
      }

      const finalSourceTree = applyTreeToLiveJsonPath(ctx, exportTree, knownLiveTree);
      git.advanceBaseRef(stateKey, exportTree);
      meta.write(meta.getClean(exportTree, finalSourceTree, syncCommit));
      return { result: 'clean' };
    }

    // Source has not moved since the recorded base: nothing to reconcile, apply directly.
    if (currentSourceTree === mergeBase) {
      log.info('Current source equals base tree; applying export directly.');
      const finalSourceTree = applyTreeToLiveJsonPath(ctx, exportTree, knownLiveTree);
      git.advanceBaseRef(stateKey, exportTree);
      meta.write(meta.getClean(exportTree, finalSourceTree, syncCommit));
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
      const finalSourceTree = applyTreeToLiveJsonPath(ctx, mergeResult.resultTree, knownLiveTree);
      git.advanceBaseRef(stateKey, exportTree);
      meta.write(meta.getClean(exportTree, finalSourceTree, syncCommit));
      return { result: 'clean' };
    }

    log.info('Merge completed with conflicts; applying conflicted result to live JSON path.');
    applyConflictedMergeToLiveJsonPath(ctx, mergeResult, knownLiveTree);
    git.setPendingRefs(stateKey, currentSourceTree, exportTree);
    meta.write(meta.getPending(mergeBase, currentSourceTree, exportTree));
    log.warning('Export completed with conflicts. Resolve the JSON path with your Git client.');
    return { result: 'conflict' };
  } finally {
    handoff.clear();
  }
}

/**
 * Revert the import-irrelevant keys that often cause merge conflicts in the freshly exported cache
 * before it enters reconciliation. For each class.json the export modified relative to the source,
 * each irrelevant-key line is reverted to its value in `currentSourceTree` (the source side of the
 * upcoming merge), so the export and source agree on those keys and they neither diff nor conflict.
 *
 * Files new in the export have no source counterpart, so they keep their initial values.
 * Likewise, deletions are also left alone.
 *
 * @param {import('../context.js').Context} ctx
 * @param {string} exportDirectory   absolute path to the export cache on disk
 * @param {string} currentSourceTree tree SHA of the source side, the values to revert to
 * @param {string} exportTree        tree SHA built from the cache before scrubbing
 * @returns {string} the export tree SHA: rebuilt (exportTree patched with the reverted files)
 *                   when anything was reverted, or `exportTree` unchanged when there was nothing
 *                   to do.
 */
function cleanExportTree(ctx, exportDirectory, currentSourceTree, exportTree) {
  const { git, log } = ctx;

  // Files the export modified relative to the source. Additions (no source counterpart) and
  // deletions are skipped — there is nothing to revert them to.
  const nameStatus = git.invoke(['diff-tree', '-r', '--no-commit-id', '--name-status', currentSourceTree, exportTree]);
  if (!nameStatus) {
    return exportTree;
  }

  const revertedPaths = [];
  for (const line of nameStatus.split(/\r?\n/).filter(Boolean)) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const status = line.slice(0, tab);
    const rel = line.slice(tab + 1);
    if (!status.startsWith('M') || path.basename(rel) !== 'class.json') {
      continue;
    }

    // The source-side version of this file; skip if it is not a readable blob.
    const sourceBlob = git.invokeRaw(['cat-file', '-p', `${currentSourceTree}:${rel}`]);
    if (sourceBlob.status !== 0) {
      continue;
    }

    if (cleanFileLines(path.join(exportDirectory, rel), sourceBlob.stdout)) {
      revertedPaths.push(rel);
      log.debug(`Reverted irrelevant-key changes in ${rel}`);
    }
  }

  if (revertedPaths.length === 0) {
    return exportTree;
  }

  // Patch only the reverted files onto the already-built exportTree rather than re-scanning the
  // whole cache: hash the rewritten files in one process, overlay them on a scratch index seeded
  // from exportTree, and write the tree back. This avoids a second full working-tree scan (the
  // untracked-file walk that dominates a from-scratch rebuild).
  log.info(`Cleaned up ${revertedPaths.length} file(s); rebuilding export tree.`);
  const objectIds = git.hashObjects(revertedPaths.map(rel => path.join(exportDirectory, rel)));
  const indexRecords = revertedPaths.map((rel, i) => `${FILE_MODE_REGULAR} ${objectIds[i]}\t${rel}`);
  return git.withScratchIndex((scratch) => {
    scratch.invoke(['read-tree', exportTree]);
    scratch.invoke(['update-index', '--index-info'], { input: indexRecords.join('\n') + '\n' });
    return scratch.invoke(['write-tree']);
  });
}

/**
 * Revert the irrelevant-key lines in the file at `cacheFilePath` to the matching lines in
 * `sourceContent`, in place. For each key, the lines in each version are paired in order of
 * appearance; pairing only happens when both versions hold the same number of that key's lines,
 * so a structural change (a differing count) is left untouched rather than guessed at. The file's
 * existing newline style and trailing newline are preserved.
 *
 * @param {string} cacheFilePath  absolute path to the cache file to rewrite
 * @param {string} sourceContent  raw text of the source-side version
 * @returns {boolean} true when the file was changed
 */
function cleanFileLines(cacheFilePath, sourceContent) {
  const raw = fs.readFileSync(cacheFilePath, 'utf-8');
  const eol = raw.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const hadTrailingNewline = raw.endsWith('\n');

  const cacheLines = raw.split(/\r?\n/);
  if (hadTrailingNewline) {
    cacheLines.pop();
  }
  const sourceLines = sourceContent.split(/\r?\n/);

  let changed = false;
  for (const key of IRRELEVANT_KEYS) {
    const keyRx = new RegExp('"' + key + '"\\s*:');
    const cacheIndices = [];
    for (let i = 0; i < cacheLines.length; i++) {
      if (keyRx.test(cacheLines[i])) {
        cacheIndices.push(i);
      }
    }
    const sourceMatches = sourceLines.filter(sourceLine => keyRx.test(sourceLine));

    // Only safe to pair when both sides hold the same number of this key's lines.
    if (cacheIndices.length === 0 || cacheIndices.length !== sourceMatches.length) {
      continue;
    }

    cacheIndices.forEach((lineIndex, i) => {
      if (cacheLines[lineIndex] !== sourceMatches[i]) {
        cacheLines[lineIndex] = sourceMatches[i];
        changed = true;
      }
    });
  }

  if (!changed) {
    return false;
  }

  let output = cacheLines.join(eol);
  if (hadTrailingNewline) {
    output += eol;
  }
  fs.writeFileSync(cacheFilePath, output, 'utf-8');
  return true;
}

/**
 * Make the live JSON path on disk match `exportTree`, writing only the delta and leaving the
 * user's staging intact. A no-op when the path already equals the tree (the common
 * repeated-export-of-identical-content case).
 *
 * Returns the tree the JSON path ACTUALLY hashes to afterwards. On a no-op that is the known
 * live tree (no re-hash needed). On a write it must be recomputed: writing `exportTree`'s blobs
 * and re-hashing does not always reproduce `exportTree` — content filters (autocrlf/eol) and
 * ignore-scope differences between the cache and the live path can yield a different SHA. The
 * caller records this as the source tree, so it must be what the next pre-export will compute.
 *
 * @param {import('../context.js').Context} ctx
 * @param {string} exportTree     tree SHA the JSON path should contain
 * @param {string} [knownLiveTree] the JSON path's current tree if already known (see the
 *                                 pre-export handoff), avoiding a fresh hashTree; null to re-hash
 * @returns {string} the tree SHA the JSON path actually holds after the call
 */
function applyTreeToLiveJsonPath(ctx, exportTree, knownLiveTree) {
  const { git, jsonPath } = ctx;

  const liveTree = knownLiveTree != null ? knownLiveTree : git.hashTree(jsonPath);
  if (liveTree === exportTree) {
    // Disk already matches; it hashes to liveTree (=== exportTree). No write, no re-hash.
    return liveTree;
  }

  const changes = writeLiveJsonPathDelta(ctx, exportTree, liveTree);
  resetStagedChanges(ctx, changes);
  return git.hashTree(jsonPath);
}

/**
 * Apply a conflicted three-way merge to the live JSON path. Two parts: write merge-tree's
 * best-effort result tree to disk (so the user sees the merged content with conflict markers),
 * then reproduce in the real index the unmerged entries merge-tree reported, so the conflict
 * shows up as `UU` in `git status` and resolves with a normal Git client.
 *
 * @param {import('../context.js').Context} ctx
 * @param {object} mergeResult  from git.mergeTree: { resultTree, lines, ... }
 * @param {string} [knownLiveTree] the JSON path's current tree if already known, avoiding a
 *                                 fresh hashTree; null to re-hash
 */
function applyConflictedMergeToLiveJsonPath(ctx, mergeResult, knownLiveTree) {
  const { git, jsonPath } = ctx;

  if (!mergeResult.resultTree) {
    throw new GitToolsError(ErrorCodes.NO_MERGE_TREE, 'merge-tree did not return a result tree.');
  }

  const liveTree = knownLiveTree != null ? knownLiveTree : git.hashTree(jsonPath);
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
  const { git, log, jsonPath, jsonAbsolutePath, repoRoot } = ctx;

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
  // (the user's staging) is never touched. We graft the subtree at its real repository path and
  // run the checkout with the work tree at the repository root, so git resolves .gitattributes
  // (text / eol / -text) and core.autocrlf exactly as a normal checkout would. A work tree rooted
  // at the JSON subpath never sees the repo-root .gitattributes, which lets core.autocrlf silently
  // rewrite line endings (e.g. LF -> CRLF) — making git report whole files as changed.
  if (writes.length > 0) {
    fs.mkdirSync(jsonAbsolutePath, { recursive: true });
    const prefix = jsonPath === '.' ? '' : `${jsonPath}/`;
    git.withScratchIndex((scratch) => {
      scratch.invoke(prefix ? ['read-tree', `--prefix=${prefix}`, tree] : ['read-tree', tree]);
      scratch.invoke(['checkout-index', '-f', '--stdin'], {
        workTree: repoRoot,
        input: writes.map(w => `${prefix}${w}`).join('\n') + '\n',
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
