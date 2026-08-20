// The per-invocation state every operation handler needs, derived once from the incoming request.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { GitToolsError, ErrorCodes } = require('./constants.js');
const { createGit } = require('./git.js');
const { createLogger } = require('./log.js');
const { createMeta } = require('./meta.js');
const { createHandoff } = require('./handoff.js');

/**
 * @typedef {object} Context
 * @property {string} repoRoot          absolute, resolved repository root (derived from jsonPath)
 * @property {string} jsonPath          repo-relative POSIX path to the export root (a git pathspec)
 * @property {string} jsonAbsolutePath  absolute path to the export root on disk
 * @property {string} libraryId
 * @property {string} libraryPath       absolute path to the .lbs file (drives the state key)
 * @property {string} stateKey          sha1-derived key identifying this library's state
 * @property {string} stateRoot         PER-WORKTREE state dir (".../gittools/<stateKey>")
 * @property {string} metaPath          meta.json within stateRoot, unless request overrides it
 * @property {string} exportCache       the export cache directory within stateRoot (a build artifact)
 * @property {string} exportCacheIndex  the persistent git index describing that cache
 * @property {object} meta              meta file helper
 * @property {object} handoff           handoff file helper
 * @property {object} config            normalized config ({ gitPath, logLevel, ... })
 * @property {object} git               git runner bound to config.gitPath + cwd=repoRoot (see git.js)
 * @property {object} log               level-aware logger built from config.logLevel (see log.js)
 */

/**
 * Build the Context for a request.
 *
 * @param {object} request
 * @returns {Context}
 */
function createContext(request) {
  const ctx = {};

  const config = request.config || {};
  ctx.config = {
    gitPath: config.gitPath || 'git',
    logLevel: config.logLevel || 'info',
  };

  /// One-liners
  ctx.libraryId = request.libraryId;
  ctx.libraryPath = request.libraryPath;
  ctx.log = createLogger({ level: ctx.config.logLevel });

  /// ctx.repoRoot — derived from the export path; Omnis no longer passes it in. The library may
  /// live outside the repository and the export path may not exist yet, so resolveRepoRoot probes
  /// from the nearest existing ancestor and lets git resolve .git-file/submodule indirection. The
  /// path must be absolute: without a repoRoot there is nothing to anchor a relative path against.
  if (!request.jsonPath || !path.isAbsolute(request.jsonPath)) {
    throw new GitToolsError(ErrorCodes.BAD_REQUEST, `jsonPath must be an absolute path: ${request.jsonPath}`);
  }
  ctx.repoRoot = createGit({ gitPath: ctx.config.gitPath, log: ctx.log }).resolveRepoRoot(request.jsonPath);
  if (!ctx.repoRoot) {
    throw new GitToolsError(ErrorCodes.BAD_REQUEST, `jsonPath is not inside a git repository: ${request.jsonPath}`);
  }
  ctx.git = createGit({ gitPath: ctx.config.gitPath, cwd: ctx.repoRoot, log: ctx.log });

  /// ctx.jsonPath — repo-relative POSIX path. Canonicalize the export path (collapsing symlinks
  /// like macOS /var -> /private/var) so the relative math against the canonical repoRoot holds
  /// even when the export root does not exist yet.
  const relativeJsonPath = path.relative(ctx.repoRoot, realpathExistingPrefix(request.jsonPath));
  const first = relativeJsonPath.split(path.sep, 1)[0];
  if (relativeJsonPath === '' || first === '..') {
    throw new GitToolsError(
      ErrorCodes.BAD_REQUEST,
      `jsonPath must be inside the repository. repoRoot: ${ctx.repoRoot}, jsonPath: ${request.jsonPath}`
    );
  }

  ctx.jsonPath = relativeJsonPath.split(path.sep).join('/');

  /// ctx.stateKey
  let canonicalKey = ctx.libraryPath ? realpathExistingPrefix(ctx.libraryPath) : ctx.libraryId;
  const libraryName = path.basename(canonicalKey, path.extname(canonicalKey));
  if (process.platform !== 'linux') {
    canonicalKey = canonicalKey.toLowerCase();
  }
  const safeLibraryName = libraryName.replace(/[^A-Za-z0-9_.-]/g, "_");
  const canonicalHash = crypto.createHash('sha1').update(canonicalKey).digest('hex').slice(0, 8);
  ctx.stateKey = `${safeLibraryName}-${canonicalHash}`;

  /// ctx.stateRoot
  ctx.stateRoot = ctx.git.resolvePrivatePath(`gittools/${ctx.stateKey}`);
  fs.mkdirSync(ctx.stateRoot, { recursive: true });

  /// One-liners depending on other parts of the context
  ctx.metaPath = request.metaPath || path.join(ctx.stateRoot, "meta.json");
  ctx.jsonAbsolutePath = path.join(ctx.repoRoot, ctx.jsonPath);
  // Derived here, not at each use site: pre-export creates the cache, post-export hashes it, and
  // clearExportCache deletes it. A convention spelled out in three places is one rename away from
  // an operation quietly acting on the wrong directory.
  ctx.exportCache = path.join(ctx.stateRoot, 'export-cache');
  ctx.exportCacheIndex = `${ctx.exportCache}.index`;

  // Helper objects
  ctx.meta = createMeta(ctx.metaPath, ctx.jsonPath);
  ctx.handoff = createHandoff(ctx.stateRoot);

  return ctx;
}

/**
 * Resolves `p` to an absolute, canonical path even when it does not exist yet: realpaths the
 * longest existing prefix (collapsing symlinks) and re-appends the missing tail. Keeps
 * repo-relative math correct for a not-yet-created export root.
 */
function realpathExistingPrefix(p) {
  let existing = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      return path.resolve(p); // no existing prefix found (reached the filesystem root)
    }
    tail.unshift(path.basename(existing));
    existing = parent;
  }

  return path.join(fs.realpathSync(existing), ...tail);
}

module.exports = { createContext };
