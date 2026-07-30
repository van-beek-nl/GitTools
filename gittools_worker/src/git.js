// Git executable helper. Thin wrapper around child_process.spawnSync for convenience and consistency.

const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const { GitToolsError, ErrorCodes } = require('./constants.js');
const { splitLines } = require('./text.js');

// spawnSync caps captured stdout at ~1 MB by default and silently errors past it.
// Batched calls (cat-file --batch-check, ls-files --stage, hash-object --stdin-paths)
// can far exceed that on a large library, so we raise the cap well above any realistic
// export.
const MAX_BUFFER = 256 * 1024 * 1024;
// Ceiling on (lineage trees x paths) lookups in one blobsRecordedInLineage batch, so a long-lived
// lineage cannot turn a provenance check into an unbounded cat-file batch.
const MAX_LINEAGE_QUERIES = 200000;
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

    const env = Object.assign({}, process.env, opts.env || {});
    if (opts.indexFile) { env.GIT_INDEX_FILE = opts.indexFile; }
    if (opts.workTree) { env.GIT_WORK_TREE = opts.workTree; }

    // Time each subprocess only when debug logging is active, so production runs pay neither the
    // measurement nor the buffered log line; under debug it is a cheap, useful per-command profile.
    const timing = log && log.isLevelEnabled('debug');
    const startedAt = timing ? performance.now() : 0;
    const result = spawnSync(gitPath, args, {
      cwd: opts.cwd || baseCwd,
      input: opts.input,
      env: env,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    if (timing) {
      log.debug('git ' + args.join(' ') + ` (${(performance.now() - startedAt).toFixed(1)}ms)`);
    }

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

  /**
   * The configured git's version number (e.g. "2.39.3"), with git's "git version " prefix
   * stripped. Throws if the executable is unavailable.
   */
  function version() {
    return invoke(['--version']).replace(/^git version /, '');
  }

  /**
   * Resolves the repository root (work-tree top level) that owns `startPath`, regardless of
   * this runner's bound cwd. The path may not exist yet (e.g. before the first export), so we
   * probe from its nearest existing ancestor. Git resolves any `.git`-file / submodule
   * indirection itself, so the result is the innermost repository that actually tracks it.
   *
   * Not being inside a repository is a normal outcome, returned as '' (so callers like
   * registration can skip with a friendly warning); only an unrunnable git throws.
   *
   * @param {string} startPath  the path to resolve from (absolute), existing or not
   * @returns {string} absolute repository root, or '' when not inside a repository
   */
  function resolveRepoRoot(startPath) {
    // Probe from the nearest existing ancestor directory (startPath itself may not exist yet).
    let probeDirectory = path.resolve(startPath);
    while (!fs.existsSync(probeDirectory)) {
      const parent = path.dirname(probeDirectory);
      if (parent === probeDirectory) {
        break;
      }
      probeDirectory = parent;
    }
    probeDirectory = fs.statSync(probeDirectory).isDirectory() ? probeDirectory : path.dirname(probeDirectory);

    const result = invokeRaw(['rev-parse', '--show-toplevel'], { cwd: probeDirectory });
    if (result.status !== 0) {
      return '';
    }

    const toplevel = result.stdout.trim();
    return toplevel ? fs.realpathSync(toplevel) : '';
  }

  /**
   * Whether this runner's repository is itself a submodule of a superproject, detected via
   * `git rev-parse --show-superproject-working-tree`: a non-empty result is the superproject's
   * work tree, so we are a submodule. Fails open — a non-zero exit or empty output is
   * reported as `false`.
   *
   * @returns {boolean} true when the repository root is a submodule working tree
   */
  function isSubmodule() {
    const result = invokeRaw(['rev-parse', '--show-superproject-working-tree']);
    return result.status === 0 && result.stdout.trim() !== '';
  }

  /** Checks whether the git version used has git merge-tree --write-tree capabilities */
  function mergeTreeHasWriteTreeCapabilities() {
    const result = invokeRaw(['merge-tree', '-h']);
    return result.stdout.includes('--write-tree');
  }

  /**
   * Resolves a path inside this worktree's PRIVATE git dir (per-worktree: `.git/worktrees/<id>/`
   * for a linked worktree). Used for mutable per-worktree state. Returns an absolute path.
   *
   * @param {string} relativePath  path relative to the private git dir (e.g. "gittools/<key>")
   * @returns {string} absolute path
   */
  function resolvePrivatePath(relativePath) {
    const privatePath = invoke(['rev-parse', '--git-path', relativePath]);
    return path.isAbsolute(privatePath) ? privatePath : path.join(baseCwd, privatePath);
  }

  /**
   * Resolves a path inside the COMMON git dir (the main `.git`, shared by every worktree).
   * Used for state that must be shared across worktrees. Returns an absolute path.
   *
   * @param {string} relativePath  path relative to the common git dir
   * @returns {string} absolute path
   */
  function resolveCommonPath(relativePath) {
    let commonDirectory = invoke(['rev-parse', '--git-common-dir']);
    if (!path.isAbsolute(commonDirectory)) {
      commonDirectory = path.join(baseCwd, commonDirectory);
    }

    return path.join(commonDirectory, relativePath);
  }

  /** True if the real index has unmerged (conflict) entries. */
  function indexHasUnmergedEntries() {
    return invoke(['ls-files', '--unmerged']) !== '';
  }

  /** True if `repoPath` has unresolved merge conflicts (unmerged paths under it). */
  function hasUnresolvedConflicts(repoPath) {
    return invoke(['diff', '--name-only', '--diff-filter=U', '--', repoPath]) !== '';
  }

  /** True if `repoPath` has any staged or unstaged changes (porcelain is non-empty). */
  function isPathDirty(repoPath) {
    return invoke(['status', '--porcelain', '--', repoPath]) !== '';
  }

  /** True if the repository has at least one commit (HEAD resolves). */
  function doesHeadExist() {
    return invokeRaw(['rev-parse', '--verify', 'HEAD']).status === 0;
  }

  /** The current HEAD commit SHA, or '' when there is no HEAD. */
  function headCommit() {
    const result = invokeRaw(['rev-parse', '--verify', '--quiet', 'HEAD']);
    return result.status === 0 ? result.stdout.trim() : '';
  }

  /** True if `ancestor` is `descendant`, or an ancestor of it. */
  function isAncestor(ancestor, descendant) {
    if (!ancestor || !descendant) {
      return false;
    }
    if (ancestor === descendant) {
      return true;
    }
    return invokeRaw(['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
  }

  /** The SHA at `repoPath` in HEAD (tree for a directory, blob for a file), or '' if absent/unborn. */
  function headSubtree(repoPath) {
    const result = invokeRaw(['rev-parse', '--verify', '--quiet', `HEAD:${repoPath}`]);
    return result.status === 0 ? result.stdout.trim() : '';
  }

  /** True if `repoPath` exists in the HEAD commit's tree. */
  function isPathInHead(repoPath) {
    return headSubtree(repoPath) !== '';
  }

  /**
   * Hashes the given files into the object store (`hash-object -w`) in one git process,
   * returning their object ids in input order. Empty input -> empty array.
   *
   * @param {string[]} filePaths  absolute file paths to hash
   * @returns {string[]} object ids, one per input path, in order
   */
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
   * The blob ids the base lineage has ever recorded at each of `paths` — the provenance record of
   * what the LIBRARY itself has produced there, as opposed to what arrived from git. Every export
   * and import chains a tree onto the lineage ref, so a blob appearing in it means the library
   * produced that exact content at some point.
   *
   * Fails open: no ref, an unreadable lineage, or a batch whose output does not line up with its
   * input all yield an empty map, which callers must treat as "no provenance known". That is the
   * safe direction — it degrades to the behaviour of not consulting provenance at all.
   *
   * @param {string} ref         fully-qualified lineage ref (refs/gittools/<key>/base)
   * @param {string[]} paths     repo-relative paths (relative to the lineage trees) to look up
   * @param {number} maxCommits  newest-first bound on how far back the lineage is walked
   * @returns {Map<string, Set<string>>} path -> set of blob ids recorded at that path
   */
  function blobsRecordedInLineage(ref, paths, maxCommits) {
    const empty = new Map();
    if (!paths || paths.length === 0) {
      return empty;
    }

    if (!resolveRef(ref)) {
      if (log) { log.info(`No base lineage at ${ref}; every path reads as unknown provenance.`); }
      return empty;
    }

    const result = invokeRaw(
      ['rev-list', '--format=%T', '--no-commit-header', `--max-count=${maxCommits}`, ref]
    );
    if (result.status !== 0) {
      if (log) { log.warning(`Could not read the base lineage at ${ref}; every path reads as unknown provenance.`); }
      return empty;
    }

    // Newest first, so the trees most likely to answer the question come first when the cap
    // below truncates a long lineage.
    let trees = splitLines(result.stdout);
    const walked = trees.length;
    const maxTrees = Math.floor(MAX_LINEAGE_QUERIES / paths.length);
    if (trees.length > maxTrees) {
      trees = trees.slice(0, Math.max(1, maxTrees));
    }
    if (trees.length === 0) {
      return empty;
    }

    // Say so when the answer comes from only part of the lineage: anything the library produced
    // before the cut reads as unknown provenance, which is the one way this check can be wrong
    // rather than merely conservative. Without this line that outcome is invisible in a trace.
    if (log && (trees.length < walked || walked >= maxCommits)) {
      const scanned = walked >= maxCommits ? `${maxCommits}+` : `${walked}`;
      log.info(`Base lineage provenance limited to the newest ${trees.length} of ${scanned} entries across ${paths.length} path(s); older library output reads as unknown provenance.`);
    }

    const queries = [];
    for (const tree of trees) {
      for (const repoPath of paths) {
        queries.push(`${tree}:${repoPath}`);
      }
    }

    // cat-file --batch-check emits exactly one line per input rev, in order: "<oid> blob <size>"
    // for a hit, "<rev> missing" for a miss. Anything else means we cannot trust the alignment.
    const lines = catFileBatchCheck(queries);
    if (lines.length !== queries.length) {
      if (log) { log.warning(`Lineage lookup returned ${lines.length} records for ${queries.length} queries; every path reads as unknown provenance.`); }
      return empty;
    }

    const recorded = new Map();
    for (let i = 0; i < lines.length; i++) {
      const fields = lines[i].trim().split(' ');
      if (fields.length < 2 || fields[1] !== 'blob') {
        continue;
      }

      const repoPath = paths[i % paths.length];
      let seen = recorded.get(repoPath);
      if (!seen) {
        seen = new Set();
        recorded.set(repoPath, seen);
      }
      seen.add(fields[0]);
    }

    return recorded;
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

  /**
   * Computes the tree SHA for the current on-disk contents under `hashRoot`, patching the
   * index named in `opts.indexFile` in place: it applies the working-tree delta (modified,
   * deleted, and untracked files) to that index, then writes the tree. This is the incremental
   * build used for the export cache (a persistent cache index + GIT_WORK_TREE=cache), and the
   * fast path of hashTree (a throwaway copy of the real index). Falls back to
   * hashTreeFromScratch when a prefixed write-tree is not possible.
   *
   * @param {string|null} hashRoot  subtree to hash (a pathspec), or null/'.' for the whole index
   * @param {object} [opts]  invokeRaw options; typically { indexFile, workTree }
   * @returns {string} tree SHA
   */
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

    // Add untracked file paths to pending hash list. --exclude-standard makes this honor
    // .gitignore (and the global/info excludes), so ignored junk like macOS .DS_Store never
    // leaks into the computed tree — matching git's own view of the source.
    for (const line of splitLines(invoke(['ls-files', '--others', '--exclude-standard', ...pathspecArgs], opts))) {
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

      for (const repoPath of splitLines(invoke(['ls-files', '--others', '--exclude-standard', '--', hashRoot]))) {
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
        const result = /^(\d{6}) ([0-9a-fA-F]{40,64}) 0\t(.+)$/.exec(line);
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

  /**
   * Runs a three-way merge of two trees against a common ancestor with
   * `git merge-tree --write-tree`, without touching the working tree or index. Exit 0 is a
   * clean merge, exit 1 is a conflicted merge (both are normal outcomes); any other exit
   * throws. The result tree is merge-tree's best effort (with conflict markers when conflicted),
   * and `lines` carries its conflicted-file records.
   *
   * @param {string} baseTree    common-ancestor tree SHA (--merge-base)
   * @param {string} sourceTree  one side of the merge
   * @param {string} exportTree  the other side of the merge
   * @returns {{status:number, resultTree:string, lines:string[]}}
   */
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

  /**
   * Advances this library's base lineage by committing `tree` onto `refs/gittools/<key>/base`.
   * The ref lives outside refs/worktree, so the base lineage is SHARED across all worktrees
   * (every export/import an ancestor a later export can reconcile against); see preExport's
   * history walk. Each call chains a new commit onto the previous tip.
   *
   * @param {string} key   state key identifying the library
   * @param {string} tree  tree SHA to record as the new base
   */
  function advanceBaseRef(key, tree) {
    const ref = `refs/gittools/${key}/base`;

    // Skip a no-op advance: if the lineage tip already records this exact tree (a repeated
    // import/export of identical content), chaining another commit would only grow the lineage
    // with a duplicate. The tree stays discoverable via the existing tip, so nothing is lost.
    const tip = resolveRef(ref);
    if (tip && resolveRef(`${tip}^{tree}`) === tree) {
      return;
    }

    advanceRef(ref, tree, { message: 'GitTools base' });
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
    resolveRepoRoot: resolveRepoRoot,
    isSubmodule: isSubmodule,
    mergeTreeHasWriteTreeCapabilities: mergeTreeHasWriteTreeCapabilities,
    resolvePrivatePath: resolvePrivatePath,
    resolveCommonPath: resolveCommonPath,
    indexHasUnmergedEntries: indexHasUnmergedEntries,
    hasUnresolvedConflicts: hasUnresolvedConflicts,
    isPathDirty: isPathDirty,
    doesHeadExist: doesHeadExist,
    headCommit: headCommit,
    isAncestor: isAncestor,
    headSubtree: headSubtree,
    isPathInHead: isPathInHead,
    hashObjects: hashObjects,
    catFileBatchCheck: catFileBatchCheck,
    blobsRecordedInLineage: blobsRecordedInLineage,
    withScratchIndex: withScratchIndex,
    hashTree: hashTree,
    mergeTree: mergeTree,
    resolveRef: resolveRef,
    advanceBaseRef: advanceBaseRef,
    setPendingRefs: setPendingRefs,
    deletePendingRefs: deletePendingRefs
  };
}

/** A unique, non-colliding temp file path (not created) of the form <tmpdir>/<prefix>-<hex>. */
function tempFilePath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID().replace(/-/g, '')}`);
}

module.exports = { createGit };
