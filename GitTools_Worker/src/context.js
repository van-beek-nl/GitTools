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
 * @property {string} repoRoot          absolute, resolved repository root
 * @property {string} jsonPath          repo-relative POSIX path to the export root (a git pathspec)
 * @property {string} jsonAbsolutePath  absolute path to the export root on disk
 * @property {string} libraryId
 * @property {string} libraryPath       absolute path to the .lbs file (drives the state key)
 * @property {string} stateKey          sha1-derived key identifying this library's state
 * @property {string} stateRoot         PER-WORKTREE state dir (".../gittools/<stateKey>")
 * @property {string} metaPath          meta.json within stateRoot, unless request overrides it
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
  ctx.repoRoot = fs.realpathSync(request.repoRoot);
  ctx.git = createGit({ gitPath: ctx.config.gitPath, cwd: ctx.repoRoot, log: ctx.log });
  
  /// ctx.jsonPath
  let relativeJsonPath;
  if (path.isAbsolute(request.jsonPath)) {
    const absoluteJsonPath = fs.existsSync(request.jsonPath) ? fs.realpathSync(request.jsonPath) : path.resolve(request.jsonPath);
    relativeJsonPath = path.relative(ctx.repoRoot, absoluteJsonPath);
    const first = relativeJsonPath.split(path.sep, 1)[0];
    if (relativeJsonPath === '' || first === '..') {
      throw new GitToolsError(
        ErrorCodes.BAD_REQUEST,
        `jsonPath must be inside the repository. repoRoot: ${ctx.repoRoot}, jsonPath: ${request.jsonPath}`
      );
    }
  } else {
    relativeJsonPath = request.jsonPath;
  }

  ctx.jsonPath = relativeJsonPath.split(path.sep).join('/');

  /// ctx.stateKey
  let canonicalKey = ctx.libraryPath ? path.resolve(ctx.libraryPath) : ctx.libraryId;
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

  // Helper objects
  ctx.meta = createMeta(ctx.metaPath, ctx.jsonPath);
  ctx.handoff = createHandoff(ctx.stateRoot);

  return ctx;
}

module.exports = { createContext };
