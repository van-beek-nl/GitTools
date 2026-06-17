// Shared helpers for the GitTools worker e2e suites (test/*.test.js).
//
// These drive the worker exactly the way Omnis does: in-process via run(request)
// from ../src/core.js, with state located through createContext(request). The
// previous PowerShell suites had to shell out to a CLI adapter (and a get-state-info
// shim) for the same thing; here it is all direct function calls, no child Node.
//
// This lives outside test/ on purpose: `node --test` (the npm test script) auto-discovers
// every .js file under a test/ directory as a test file, so a shared module kept in test/
// would run as an empty "test". From test-support/ the suites import it explicitly instead.
//
// Zero dependencies: Node core only (node:test in the suites, built-ins here).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { run } = require('../src/core.js');
const { createContext } = require('../src/context.js');

const MAX_BUFFER = 256 * 1024 * 1024;

// The export root every suite uses (a nested path, so the prefixed-pathspec handling
// gets exercised rather than the json-path-is-repo-root special case).
const J = 'Source/Lib';

// Quiet the worker's own logging in test output; behaviour does not depend on it.
const CONFIG = { logLevel: 'error' };

// Temp dirs/files created by the helpers, removed when this test process exits.
// node:test runs each test file in its own process, so a per-file exit hook is enough
// and never races another suite.
const cleanupPaths = [];
process.on('exit', () => {
  for (const p of cleanupPaths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
});

function tmpName(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(6).toString('hex')}`);
}

// git that throws on failure and returns trimmed stdout (stderr suppressed).
function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) { throw new Error(`git ${args.join(' ')} failed (exit ${r.status})`); }
  return (r.stdout || '').trim();
}

// git that never throws; returns the raw (untrimmed) outcome. Use for status/rev-parse
// where a non-zero exit or leading whitespace is meaningful.
function gitTry(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// A fresh throwaway repo with the .lbs placeholder.
function newRepo(prefix) {
  const r = tmpName(prefix || 'e2e');
  fs.mkdirSync(r, { recursive: true });
  cleanupPaths.push(r);
  git(r, 'init', '-q');
  git(r, 'config', 'user.email', 't@t.t');
  git(r, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'Lib.lbs'), 'bin');
  return r;
}

function libOf(repo) { return path.join(repo, 'Lib.lbs'); }

function request(operation, repo, json, lib, opts) {
  opts = opts || {};
  return {
    operation,
    repoRoot: repo,
    jsonPath: json,
    libraryId: 'LIB',
    libraryPath: lib,
    allowMissingBase: !!opts.allowMissingBase,
    config: CONFIG,
  };
}

// The per-library state context. createContext ignores `operation` and derives everything
// (stateRoot, stateKey, the git/meta/handoff helpers) from the repo/json/library fields,
// so this is the in-process replacement for the old get-state-info CLI shim.
function ctxFor(repo, json, lib) {
  return createContext(request('context', repo, json, lib));
}

function stateRoot(repo, json, lib) { return ctxFor(repo, json, lib).stateRoot; }
function stateKey(repo, json, lib) { return ctxFor(repo, json, lib).stateKey; }
function cacheDir(repo, json, lib) { return path.join(stateRoot(repo, json, lib), 'export-cache'); }
function handoffPath(repo, json, lib) { return path.join(stateRoot(repo, json, lib), 'pending-op.json'); }

// Run one operation in-process. Throws on a structured failure (a real worker error),
// otherwise returns the result string ('clean' | 'conflict' | 'missing-base') or
// undefined for operations that return only { source } (pre-export / pre-import).
function runOp(operation, repo, json, lib, opts) {
  const res = run(request(operation, repo, json, lib, opts));
  if (!res.ok) { throw new Error(`${operation} failed: ${res.error.code}: ${res.error.message}`); }
  return res.result;
}

function writeFiles(root, files) {
  for (const rel of Object.keys(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, files[rel]); // no trailing newline, matching Set-Content -NoNewline
  }
}

// Simulate Omnis exporting the library: replace the export cache with a complete snapshot.
function omnisExport(repo, json, lib, files) {
  const c = cacheDir(repo, json, lib);
  fs.rmSync(c, { recursive: true, force: true });
  fs.mkdirSync(c, { recursive: true });
  writeFiles(c, files);
}

// Full export round-trip (pre + post). Returns the post-export result string.
function exportLib(repo, json, lib, files, opts) {
  omnisExport(repo, json, lib, files);
  runOp('pre-export', repo, json, lib, opts);
  return runOp('post-export', repo, json, lib, opts);
}

// Commit a source state directly (simulates a colleague's commit / a pull). With
// { clear: true } the json dir is wiped first, so deletions propagate.
function commitSource(repo, json, files, msg, opts) {
  opts = opts || {};
  const abs = path.join(repo, json);
  if (opts.clear && fs.existsSync(abs)) { fs.rmSync(abs, { recursive: true, force: true }); }
  fs.mkdirSync(abs, { recursive: true });
  writeFiles(abs, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
}

// Import: commit the source, then finalize via post-import (records base == source).
function importLib(repo, json, lib, files, opts) {
  commitSource(repo, json, files, 'import source', opts);
  return runOp('post-import', repo, json, lib);
}

// All files under the json path as { 'rel/path': content }.
function readSrc(repo, json) {
  const abs = path.join(repo, json);
  if (!fs.existsSync(abs)) { return {}; }
  const out = {};
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); }
      else { out[path.relative(abs, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8'); }
    }
  })(abs);
  return out;
}

function read1(repo, json, name) {
  const p = path.join(repo, json, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '<missing>';
}

// Porcelain XY status for a single path ('  ' when clean/absent). Untrimmed: the
// index/worktree columns are positional and a leading space is meaningful.
function stat(repo, p) {
  const s = gitTry(repo, 'status', '--porcelain', '--', p).stdout;
  return s === '' ? '  ' : s.slice(0, 2);
}

function hasConflict(repo, json) {
  return git(repo, 'diff', '--name-only', '--diff-filter=U', '--', json) !== '';
}

function readMeta(repo, json, lib) {
  const mp = path.join(stateRoot(repo, json, lib), 'meta.json');
  if (!fs.existsSync(mp)) { return {}; }
  return JSON.parse(fs.readFileSync(mp, 'utf8'));
}

// SHA the shared base lineage ref points at ('' if absent). Shared across worktrees.
function baseRefTarget(repo, json, lib) {
  const r = gitTry(repo, 'rev-parse', `refs/gittools/${stateKey(repo, json, lib)}/base`);
  return r.status === 0 ? r.stdout.trim() : '';
}

// Whether the per-worktree pending-export ref exists.
function pendingExists(repo, json, lib) {
  return gitTry(repo, 'rev-parse', `refs/worktree/gittools/${stateKey(repo, json, lib)}/pending-export`).status === 0;
}

// Register an extra path (e.g. a scratch cache dir or index) for end-of-process cleanup.
function track(p) { cleanupPaths.push(p); return p; }

module.exports = {
  J, libOf, git, gitTry, newRepo, ctxFor, stateRoot, stateKey, cacheDir, handoffPath,
  runOp, request, writeFiles, omnisExport, exportLib, commitSource, importLib,
  readSrc, read1, stat, hasConflict, readMeta, baseRefTarget, pendingExists, tmpName, track,
};
