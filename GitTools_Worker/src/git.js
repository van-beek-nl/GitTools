// Git executable helper. Thin wrapper around child_process.spawnSync for convenience and consistency.

const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { GitToolsError, ErrorCodes } = require('./constants.js');

// spawnSync caps captured stdout at ~1 MB by default and silently errors past it.
// Batched calls (cat-file --batch-check, ls-files --stage, hash-object --stdin-paths)
// can far exceed that on a large library, so we raise the cap well above any realistic
// export.
const MAX_BUFFER = 256 * 1024 * 1024;
const NULL_OBJECT_ID = '0000000000000000000000000000000000000000';
const FILE_MODE_REGULAR = '100644';

/**
 * Create a git runner bound to a configuration.
 *
 * @param {object} [options]
 * @param {string} [options.gitPath]  path to the git executable; defaults to "git" (resolved on PATH).
 *                                    This is the user-configurable path from the Omnis library.
 * @param {string} [options.cwd]      default working directory for every call (normally the repo root).
 * @param {object} [options.log]      optional logger (see log.js); debug-logs each command.
 * @returns {{invokeRaw: Function, invoke: Function, version: Function}}
 */
function createGit(options) {
  options = options || {};
  const gitPath = options.gitPath || 'git';
  const baseCwd = options.cwd;
  const log = options.log || null;

  /**
   * Invoke git once and return the raw outcome. Does NOT throw on a non-zero git exit;
   * callers decide what a non-zero status means (e.g. merge-tree exit 1 is a conflict, an
   * acceptable outcome). Throws only if git could not be spawned (e.g. wrong gitPath).
   *
   * @param {string[]} args
   * @param {object} [opts]
   * @param {string} [opts.cwd]        overrides the bound cwd for this call
   * @param {string} [opts.input]      data piped to git stdin (e.g. for --stdin-paths)
   * @param {string} [opts.indexFile]  GIT_INDEX_FILE for this call only
   * @param {string} [opts.workTree]   GIT_WORK_TREE for this call only
   * @param {object} [opts.env]        extra environment entries
   * @returns {{status:number, stdout:string, stderr:string}}
   */
  function invokeRaw(args, opts) {
    opts = opts || {};
    if (log) { log.debug('git ' + args.join(' ')); }

    const env = Object.assign({}, process.env, opts.env || {});
    if (opts.indexFile) { env.GIT_INDEX_FILE = opts.indexFile; }
    if (opts.workTree) { env.GIT_WORK_TREE = opts.workTree; }

    const result = spawnSync(gitPath, args, {
      cwd: opts.cwd || baseCwd,
      input: opts.input,
      env: env,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });

    if (result.error) {
      throw new GitToolsError(
        ErrorCodes.GIT_SPAWN_FAILED,
        'Could not run git (' + gitPath + ' ' + args.join(' ') + '): ' + result.error.message
      );
    }

    return {
      status: typeof result.status === 'number' ? result.status : 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  /**
   * Invoke git and require success. Returns trimmed stdout; throws GitToolsError with
   * git's stderr attached on any non-zero exit.
   * @param {string[]} args
   * @param {object} [opts]  same shape as invokeRaw
   * @returns {string}
   */
  function invoke(args, opts) {
    const r = invokeRaw(args, opts);
    if (r.status !== 0) {
      throw new GitToolsError(
        ErrorCodes.GIT_FAILED,
        'git ' + args.join(' ') + ' failed (exit ' + r.status + '): ' + r.stderr.trim()
      );
    }
    return r.stdout.trim();
  }

  /** The configured git's version string. Throws if the executable is unavailable. */
  function version() {
    return invoke(['--version']);
  }

  /** Checks whether the git version used has git merge-tree --write-tree capabilities */
  function mergeTreeHasWriteTreeCapabilities() {
    const result = invokeRaw(['merge-tree', '-h']);
    return result.stdout.includes('--write-tree');
  }

  function resolvePrivatePath(relativePath) {
    const privatePath = invoke(['rev-parse', '--git-path', relativePath]);
    return path.isAbsolute(privatePath) ? privatePath : path.join(baseCwd, privatePath);
  }

  function resolveCommonPath(relativePath) {
    const commonDirectory = invoke(['rev-parse', '--git-common-dir']);
    if (!path.isAbsolute(commonDirectory)) {
      commonDirectory = path.join(baseCwd, commonDirectory);
    }

    return path.join(commonDirectory, relativePath);
  }
  
  function indexHasUnmergedEntries() {
    return invoke(['ls-files', '--unmerged']) !== '';
  }

  function hasUnresolvedConflicts(repoPath) {
    return invoke(['diff', '--name-only', '--diff-filter=U', '--', repoPath]) !== '';
  }

  function isPathDirty(repoPath) {
    return invoke(['status', '--porcelain', '--', repoPath]) !== '';
  }

  function doesHeadExist() {
    return invokeRaw(['rev-parse', '--verify', 'HEAD']).status === 0;
  }

  function isPathInHead(repoPath) {
    return doesHeadExist() && invokeRaw(['rev-parse', '--verify', `HEAD:${repoPath}`]).status === 0;
  }

  function hashObjects(filePaths) {
    if (!filePaths || filePaths.length <= 0) {
      return [];
    }

    return splitLines(invoke(['hash-object', '-w', '--stdin-paths'], {
      input: filePaths.join('\n') + '\n',
    }));
  }

  /**
   * Resolves many revisions (e.g. "<commit>:<path>") to object metadata in one
   * git process via `cat-file --batch-check`. Returns one line per revision, in
   * input order: "<oid> <type> <size>" for a hit, "<rev> missing" for a miss.
   *
   * @param {string[]} revisions
   * @returns {string[]}
   */
  function catFileBatchCheck(revisions) {
    if (!revisions || revisions.length <= 0) {
      return [];
    }

    return splitLines(invoke(['cat-file', '--batch-check'], {
      input: revisions.join('\n') + '\n',
    }));
  }

  /**
   * Runs `fn` against a scratch index: a temporary, throwaway GIT_INDEX_FILE that
   * does not exist until something writes to it (e.g. `read-tree`). `fn` receives
   * a git handle whose `invokeRaw`/`invoke` are pre-bound to that scratch index, so callers
   * don't need to thread `{ indexFile }` through every call. The scratch index file
   * is removed afterwards regardless of whether `fn` throws.
   *
   * @param {(scratch: {invokeRaw: Function, invoke: Function, indexFile: string}) => any} fn
   * @returns {any} fn's return value
   */
  function withScratchIndex(fn) {
    const indexFile = tempFilePath('gittools-scratch-index');
    const scratch = {
      invokeRaw: (args, opts) => invokeRaw(args, Object.assign({}, opts, { indexFile })),
      invoke: (args, opts) => invoke(args, Object.assign({}, opts, { indexFile })),
      indexFile: indexFile,
    };

    try {
      return fn(scratch);
    } finally {
      fs.rmSync(indexFile, { force: true });
    }
  }

  function hashTreeCore(hashRoot, opts) {
    if (opts == null) {
      opts = {};
    }

    const pathspecArgs = hashRoot ? ['--', hashRoot] : [];
    const absoluteBase = opts.workTree || baseCwd;
    const indexRecords = [];
    const pendingHashes = [];

    // Add modified paths to pending hash list, update index records for deleted paths
    for (const line of splitLines(invoke(['diff-files', '--name-status', ...pathspecArgs], opts))) {
      const [status, repoPath] = line.split('\t');

      // Path marked as deleted
      if (status.startsWith('D')) {
        indexRecords.push(`0 ${NULL_OBJECT_ID}\t${repoPath}`);
        continue;
      }

      pendingHashes.push({ relative: repoPath, absolute: path.join(absoluteBase, repoPath) });
    }

    // Add untracked file paths to pending hash list
    for (const line of splitLines(invoke(['ls-files', '--others', ...pathspecArgs], opts))) {
      pendingHashes.push({ relative: line, absolute: path.join(absoluteBase, line) });
    }

    // Hash all pending paths and add them to the index record list
    const objectIds = hashObjects(pendingHashes.map(pending => pending.absolute));
    pendingHashes.forEach((pending, i) => indexRecords.push(`${FILE_MODE_REGULAR} ${objectIds[i]}\t${pending.relative}`));

    // Update scratch index with the new index records
    if (indexRecords.length > 0) {
      invoke(['update-index', '--index-info'], { input: indexRecords.join('\n') + '\n', ...opts });
    }

    if (hashRoot && hashRoot !== '.') {
      // write-tree --prefix can fail when nothing under the export path is tracked yet.
      // This means the live source is currently empty (for example: for the very first export).
      const result = invokeRaw(['write-tree', `--prefix=${hashRoot}/`], opts);
      if (result.status === 0) {
        return result.stdout.trim();
      }

      // Fall back to the scoped builder if the regular path fails
      return hashTreeFromScratch(hashRoot);
    }

    // No prefix (i.e., source lives directly in the repository root)
    return invoke(['write-tree'], opts);
  }

  /**
   * Computes the git tree SHA for the current on-disk contents of the given hash root
   * without touching the repository's real index.
   * 
   * Fast path: patches a copy of the real index with just the modifications done since then.
   * Fallback: calls hashTreeFromScratch.
   * 
   * @param {string} hashRoot Root of the hash tree 
   * @returns {string} tree SHA
   */
  function hashTree(hashRoot, opts) {
    if (opts && opts.indexFile) {
      return hashTreeCore(hashRoot, opts);
    }
    
    const index = resolvePrivatePath('index');
    if (!fs.existsSync(index) || indexHasUnmergedEntries()) {
      return hashTreeFromScratch(hashRoot);
    }

    const scratchIndex = tempFilePath('gittools-scratch-index');
    try {
      fs.copyFileSync(index, scratchIndex);
      return hashTreeCore(hashRoot, { indexFile: scratchIndex });
    } finally {
      fs.rmSync(scratchIndex, { force: true });
    }
  }

  /**
   * Slow fallback path for hashTree. Does the same work, but builds a fresh index rather
   * than re-using the current live index. This is necessary in situations where the live
   * index does not yet exist or contains unresolved conflicts, as write-tree refuses to run.
   * 
   * @param {string} hashRoot Root of the hash tree 
   * @returns {string} tree SHA
   */
  function hashTreeFromScratch(hashRoot) {
    const scratchIndex = tempFilePath('gittools-scratch-index');

    function stripRelativePrefix(repoPath) {
      const prefix = !hashRoot || hashRoot === '.' ? '' : `${hashRoot}/`;
      return prefix && repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath;
    }

    try {
      invoke(['read-tree', '--empty'], { indexFile: scratchIndex });
      const indexRecords = [];
      const pendingHashes = [];
      const handledPaths = new Set();

      for (const line of splitLines(invoke(['diff-files', '--name-status', '--', hashRoot]))) {
        const [status, repoPath] = line.split('\t');
        const strippedPath = stripRelativePrefix(repoPath);
        handledPaths.add(strippedPath);

        if (status.startsWith('D')) {
          continue;
        }

        pendingHashes.push({ relative: strippedPath, absolute: path.join(baseCwd, repoPath) });
      }

      for (const repoPath of splitLines(invoke(['ls-files', '--others', '--', hashRoot]))) {
        const strippedPath = stripRelativePrefix(repoPath);
        handledPaths.add(strippedPath);
        pendingHashes.push({ relative: strippedPath, absolute: path.join(baseCwd, repoPath) });
      }

      // Hash all pending paths and add them to the index record list
      const objectIds = hashObjects(pendingHashes.map(pending => pending.absolute));
      pendingHashes.forEach((pending, i) => indexRecords.push(`${FILE_MODE_REGULAR} ${objectIds[i]}\t${pending.relative}`));

      for (const line of splitLines(invoke(['ls-files', '--stage', '--', hashRoot]))) {
        // Regex to parse output of git ls-files:
        // <mode><space><object-sha><space><stage><tab><path>
        const result = /^(\d{6}) ([0-9a-fA-F]{40,64}) [0-9]\t(.+)$/.exec(line);
        if (result) {
          const [,, objectId, repoPath] = result;
          const strippedPath = stripRelativePrefix(repoPath);
          if (!handledPaths.has(strippedPath)) {
            indexRecords.push(`${FILE_MODE_REGULAR} ${objectId}\t${strippedPath}`);
          }
        }
      }

      // Update scratch index with the new index records
      if (indexRecords.length > 0) {
        invoke(['update-index', '--index-info'], { input: indexRecords.join('\n') + '\n', indexFile: scratchIndex });
      }

      return invoke(['write-tree'], { indexFile: scratchIndex });
    } finally {
      fs.rmSync(scratchIndex, { force: true })
    }
  }

  function mergeTree(baseTree, sourceTree, exportTree) {
    const args = ['merge-tree', '--write-tree', '--messages', `--merge-base=${baseTree}`, sourceTree, exportTree];
    const result = invokeRaw(args);

    if (result.status !== 0 && result.status !== 1) {
      throw new GitToolsError(
        ErrorCodes.GIT_FAILED,
        'git ' + args.join(' ') + ' failed (exit ' + result.status + '): ' + result.stderr.trim()
      );
    }

    const lines = splitLines(result.stdout);
    return {
      status: result.status,
      resultTree: lines.length > 0 ? lines[0].trim() : '',
      lines: lines,
      stdout: result.stdout
    };
  }

  /**
   * Resolves a ref to the object it points at.
   * 
   * @param {string} ref Fully-qualified ref name (e.g. "refs/gittools/<key>/base")
   * @returns {string} The resolved SHA hash, or '' if the ref does not exist / is invalid.
   */
  function resolveRef(ref) {
    const result = invokeRaw(['rev-parse', '--verify', '--quiet', ref]);
    return result.status === 0 ? result.stdout.trim() : '';
  }

  /**
   * Creates a commit wrapping `tree`, chained onto whatever `ref` currently
   * points at (if anything), and moves `ref` to the new commit. Used for
   * internal bookkeeping commits.
   * 
   * @param {string} ref Fully-qualified name of the ref to advance 
   * @param {string} tree Tree SHA the new commit should point at
   * @param {object} opts
   * @param {string} [opts.message] commit message, defaults to 'GitTools' 
   * @returns {string} The new commit SHA ref points at
   */
  function advanceRef(ref, tree, opts) {
    opts = opts || {};
    const commitArgs = [
      '-c', 'user.name=GitTools',
      '-c', 'user.email=gittools@localhost',
      '-c', 'commit.gpgsign=false',
      'commit-tree', tree
    ];

    const parent = resolveRef(ref);
    if (parent) {
      commitArgs.push('-p', parent);
    }
    commitArgs.push('-m', opts.message || 'GitTools');

    const commit = invoke(commitArgs);
    invoke(['update-ref', ref, commit]);
    return commit;
  }

  /**
   * Deletes the given `ref` if it exists.
   * 
   * @param {string} ref Fully-qualified name of the ref to delete
   */
  function deleteRef(ref) {
    if (resolveRef(ref)) {
      invoke(['update-ref', '-d', ref]);
    }
  }

  function advanceBaseRef(key, tree) {
    advanceRef(
      `refs/gittools/${key}/base`,
      tree,
      { message: 'GitTools base' }
    );
  }

  /**
   * Pins the source and export trees of an in-progress conflict so `git gc`
   * cannot prune them while the user resolves it. Lives in refs/worktree so
   * each worktree owns its own pending state.
   *
   * @param {string} key         State key
   * @param {string} sourceTree  Tree SHA of the pre-export source side
   * @param {string} exportTree  Tree SHA of the Omnis export side
   */
  function setPendingRefs(key, sourceTree, exportTree) {
    invoke(['update-ref', `refs/worktree/gittools/${key}/pending-source`, sourceTree]);
    invoke(['update-ref', `refs/worktree/gittools/${key}/pending-export`, exportTree]);
  }

  /**
   * Deletes all pending refs for the given state key.
   *
   * @param {string} key State key
   */
  function deletePendingRefs(key) {
    for (const name of ['pending-source', 'pending-export']) {
      deleteRef(`refs/worktree/gittools/${key}/${name}`);
    }
  }

  return {
    invokeRaw: invokeRaw,
    invoke: invoke,
    version: version,
    mergeTreeHasWriteTreeCapabilities: mergeTreeHasWriteTreeCapabilities,
    resolvePrivatePath: resolvePrivatePath,
    resolveCommonPath: resolveCommonPath,
    indexHasUnmergedEntries: indexHasUnmergedEntries,
    hasUnresolvedConflicts: hasUnresolvedConflicts,
    isPathDirty: isPathDirty,
    doesHeadExist: doesHeadExist,
    isPathInHead: isPathInHead,
    hashObjects: hashObjects,
    catFileBatchCheck: catFileBatchCheck,
    withScratchIndex: withScratchIndex,
    hashTree: hashTree,
    mergeTree: mergeTree,
    resolveRef: resolveRef,
    advanceRef: advanceRef,
    deleteRef: deleteRef,
    advanceBaseRef: advanceBaseRef,
    setPendingRefs: setPendingRefs,
    deletePendingRefs: deletePendingRefs
  };
}

function tempFilePath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID().replace(/-/g, '')}`);
}

function splitLines(string) {
  return string.split(/\r?\n/).filter(line => line !== '');
}

module.exports = { createGit };
