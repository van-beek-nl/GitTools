const fs = require('fs');
const path = require('path');

const { GitToolsError, ErrorCodes } = require('../constants.js');
const { fingerprintPath } = require('../fingerprint.js');
const { splitLines } = require('../text.js');

const FAST_HISTORY_MAX_COMMITS = 1000;
const FULL_HISTORY_MAX_COMMITS = 2147483647;
// How far back the base lineage is walked when asking whether the library ever produced HEAD's
// content for a file (see selectFilesNeedingRecordedBase). Newest-first, so a truncated walk still
// covers the recent exports that answer the question in practice.
const LINEAGE_PROVENANCE_MAX_COMMITS = 1000;

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
  if (!mergeBase && git.isPathInHead(jsonPath) && !request.allowMissingBase) {
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
    liveTree: liveTree,
    liveFingerprint: fingerprintPath(jsonAbsolutePath),
  });

  return { source: exportCache };
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
    return meta.getClean(metaObject.pending.baseTree, currentSourceTree, git.headCommit());
  }

  // The current source tree differs from pending.sourceTree. This can mean two things:
  // 1) The user manually resolved the conflicts and committed the result. The new tree
  //    contains the export's content, just merged by hand instead of by git.
  // 2) The discard step above restored the JSON path to HEAD or some other unrelated state.
  //    It differs, but not because the user resolved the merge.
  //
  // GitTools needs a way to distinguish these two situations. We do so by replaying
  // the exact same 3-way merge that originally conflicted, and asking whether it would change
  // anything: only if the merge result IS the current source tree does that tree already contain
  // everything the export wanted, which is what proves the user accepted it. `exportTree` then
  // becomes the new base and `currentSourceTree` the new source, so the next export does not
  // raise unexpected conflicts.
  //
  // A clean exit alone proves nothing, and trusting it silently destroyed work in the field: when
  // the discard above lands `currentSourceTree` on `pending.baseTree`, the replay degenerates into
  // merge(X, X, exportTree), and a merge whose base equals one of its sides can never conflict —
  // it just returns the other side. That guaranteed exit 0 was read as acceptance, so the base
  // advanced to an export tree the working tree had never taken. From then on the base equalled the
  // export, every later merge resolved to `ours`, and no library change could reach git again.
  // Comparing trees instead of statuses is not fooled by the degenerate case: there the result is
  // `exportTree`, which differs from the source that never absorbed it.
  const replay = git.mergeTree(
    metaObject.pending.baseTree,
    currentSourceTree,
    metaObject.pending.exportTree
  );
  git.deletePendingRefs(stateKey);
  if (replay.status === 0 && replay.resultTree === currentSourceTree) {
    // Replay is clean, we can safely advance the base ref
    log.info('Pending conflict was resolved and accepted; advancing base to export tree.');
    git.advanceBaseRef(stateKey, metaObject.pending.exportTree);
    return meta.getClean(metaObject.pending.exportTree, currentSourceTree, git.headCommit());
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

  const headCommit = git.headCommit();
  if (headCommit) {
    // The live source is no longer GitTools' last output (a pull, discard, or partial commit moved
    // it). The live edits are disposable; HEAD becomes the source side.
    log.info('Live JSON path has changed since last export; using HEAD as source. Live changes are disposable.');

    let mergeBase;
    if (metaObject.baseTree && metaObject.syncCommit && git.isAncestor(metaObject.syncCommit, headCommit)) {
      // HEAD is at or ahead of our last sync, so committed history since then is real work; build
      // the base per file (see buildReconciliationBase).
      log.info('HEAD is at or ahead of the last sync; building the reconciliation base from the commit graph.');
      mergeBase = buildReconciliationBase(ctx, metaObject);
    } else {
      // No recorded sync, or HEAD moved off that line (reset/branch-switch): recompute the base as
      // the common ancestor from HEAD's history. An empty result applies as if there were no base.
      const baseRefName = `refs/gittools/${stateKey}/base`;
      let lineage = [];
      if (git.resolveRef(baseRefName)) {
        const lineageResult = git.invokeRaw(['rev-list', '--format=%T', '--no-commit-header', baseRefName]);
        if (lineageResult.status === 0) {
          lineage = splitLines(lineageResult.stdout);
        }
      }
      const lineageSet = new Set(lineage);

      mergeBase = findRecordedBaseInHistory(ctx, metaObject, lineageSet, FAST_HISTORY_MAX_COMMITS);
      if (!mergeBase && lineage.length > 0) {
        log.info(`No recorded base within the last ${FAST_HISTORY_MAX_COMMITS} commits; extending search to full history.`);
        mergeBase = findRecordedBaseInHistory(ctx, metaObject, lineageSet, FULL_HISTORY_MAX_COMMITS);
      }
    }

    // No HEAD entry for jsonPath yet (e.g. before the very first export/import):
    // fall back to the empty tree.
    let sourceTree = git.headSubtree(jsonPath);
    if (!sourceTree) {
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

// Builds the merge base per file for the drift path, given HEAD is at or ahead of
// metaObject.syncCommit. Files no commit touched take HEAD's value (so the library resurfaces over
// an uncommitted working-tree discard). Files a commit changed since the sync take
// metaObject.baseTree's value ONLY when HEAD's content for them is foreign to the library — see
// selectFilesNeedingRecordedBase. The base is HEAD's subtree with those files overlaid from
// metaObject.baseTree.
function buildReconciliationBase(ctx, metaObject) {
  const { git, jsonPath } = ctx;

  const headSubtree = git.invoke(['rev-parse', `HEAD:${jsonPath}`]);

  // The jsonPath subtree at the sync commit, or the empty tree when it did not exist then.
  const syncSubtreeResult = git.invokeRaw(['rev-parse', '--verify', '--quiet', `${metaObject.syncCommit}:${jsonPath}`]);
  const syncSubtree = syncSubtreeResult.status === 0 ? syncSubtreeResult.stdout.trim() : git.invoke(['mktree'], { input: '' });

  const committedFiles = splitLines(
    git.invoke(['diff-tree', '-r', '--no-commit-id', '--name-only', syncSubtree, headSubtree])
  );
  if (committedFiles.length === 0) {
    return headSubtree;
  }

  const overlayFiles = selectFilesNeedingRecordedBase(ctx, headSubtree, committedFiles);
  if (overlayFiles.length === 0) {
    return headSubtree;
  }

  return git.withScratchIndex((scratch) => {
    scratch.invoke(['read-tree', headSubtree]);

    const records = [];
    const present = new Set();
    for (const line of splitLines(scratch.invoke(['ls-tree', metaObject.baseTree, '--', ...overlayFiles]))) {
      const match = /^(\d{6}) \w+ ([0-9a-fA-F]+)\t(.+)$/.exec(line);
      if (match) {
        records.push(`${match[1]} ${match[2]}\t${match[3]}`);
        present.add(match[3]);
      }
    }

    // Overlaid files absent from the recorded base are not part of it; drop them.
    const removed = overlayFiles.filter((file) => !present.has(file));
    if (removed.length > 0) {
      scratch.invoke(['update-index', '--force-remove', '--stdin'], { input: removed.join('\n') + '\n' });
    }
    if (records.length > 0) {
      scratch.invoke(['update-index', '--index-info'], { input: records.join('\n') + '\n' });
    }

    return scratch.invoke(['write-tree']);
  });
}

/**
 * Of the files a commit touched since the sync, the ones whose base must come from
 * metaObject.baseTree (the last export) rather than from HEAD.
 *
 * Taking baseTree's value makes the library side of the merge look unchanged for that file, so
 * HEAD wins. That is right for a peer's committed work and wrong for the developer's own
 * exported-but-uncommitted work, and the two are indistinguishable from the trees alone: both are
 * "base == theirs, ours differs". What separates them is PROVENANCE — has the library ever
 * produced what HEAD holds here?
 *
 *   - Yes: the library produced that content and has since moved past it. HEAD is not superseding
 *     anything, it is simply behind, so leaving the base at HEAD's value lets the library's newer
 *     content apply. This is the developer's own uncommitted work, which must survive.
 *   - No: the content arrived from git and the library has never seen it (a pulled peer commit).
 *     Overlay baseTree so the peer's work is protected, and so a library change to the same file
 *     surfaces as a real conflict instead of silently winning.
 *
 * The base lineage ref records every tree an export or import ever produced, which answers this
 * directly. When it is unavailable (a fresh clone, a pruned ref) no file has known provenance and
 * every file is overlaid — exactly the behaviour before provenance was consulted.
 *
 * @param {import('../context.js').Context} ctx
 * @param {string} headSubtree     HEAD's tree at jsonPath
 * @param {string[]} committedFiles files a commit changed since metaObject.syncCommit
 * @returns {string[]} the subset to overlay from the recorded base
 */
function selectFilesNeedingRecordedBase(ctx, headSubtree, committedFiles) {
  const { git, log, stateKey } = ctx;

  const headBlobs = new Map();
  for (const line of splitLines(git.invoke(['ls-tree', headSubtree, '--', ...committedFiles]))) {
    const match = /^(\d{6}) \w+ ([0-9a-fA-F]+)\t(.+)$/.exec(line);
    if (match) {
      headBlobs.set(match[3], match[2]);
    }
  }

  const recorded = git.blobsRecordedInLineage(
    `refs/gittools/${stateKey}/base`,
    committedFiles,
    LINEAGE_PROVENANCE_MAX_COMMITS
  );

  const overlayFiles = [];
  const keptFromHead = [];
  for (const file of committedFiles) {
    const headBlob = headBlobs.get(file);
    const seen = recorded.get(file);
    if (headBlob && seen && seen.has(headBlob)) {
      keptFromHead.push(file);
      continue;
    }

    overlayFiles.push(file);
  }

  // Both halves are logged, because which files landed on which side is the first thing anyone
  // debugging a "my change did not export" report needs to know, and it is not recoverable from
  // the git commands alone.
  if (keptFromHead.length > 0) {
    log.debug(`Library has produced HEAD's content for ${keptFromHead.length} file(s); basing them on HEAD so its newer content still applies.`);
  }
  if (overlayFiles.length > 0) {
    log.debug(`No recorded provenance for HEAD's content in ${overlayFiles.length} file(s); keeping the committed content and basing them on the last export.`);
  }

  return overlayFiles;
}

module.exports = { preExport };
