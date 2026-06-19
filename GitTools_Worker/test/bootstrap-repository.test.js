// bootstrapRepository reconciles a repository to the current desired GitTools state: the CR diff
// driver, the required .gitignore / .gitattributes rules, and removal of the artifacts the old
// pre-worker version left behind (the *.gittools.meta ignore rule, the <lib>.gittools.meta file,
// the .git/gittools-mapping.meta file, and the post-commit.d/gittools hook). It is idempotent.
//
// The repository-config writes (git config + the tracked .gitignore / .gitattributes) only run
// when the request sets updateRepositoryConfig; the legacy cleanup runs regardless.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { run } = require('../src/core.js');
const h = require('../test-support/helpers');
const { J } = h;

function bootstrap(repo, lib, opts) {
  return h.runOp('bootstrapRepository', repo, J, lib, opts);
}

// Repository-config writes are gated behind updateRepositoryConfig; most tests want them on.
const WITH_CONFIG = { updateRepositoryConfig: true };

function lines(repo, name) {
  const p = path.join(repo, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n') : [];
}

test('adds the required .gitignore rules and strips the legacy *.gittools.meta rule', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  // A pre-existing .gitignore carrying the user's own rule plus the stale GitTools rule.
  fs.writeFileSync(path.join(r, '.gitignore'), 'node_modules\n*.gittools.meta\n');

  bootstrap(r, lib, WITH_CONFIG);

  const ignore = lines(r, '.gitignore');
  assert.ok(ignore.includes('node_modules'), "keeps the user's own rule");
  assert.ok(!ignore.includes('*.gittools.meta'), 'removes the stale legacy rule');
  for (const rule of ['.DS_Store', '*.lbs.import', '*.lbs.bak', '*.lbs']) {
    assert.ok(ignore.includes(rule), `ensures required rule ${rule}`);
  }
});

test('creates .gitignore and .gitattributes from scratch when absent', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  bootstrap(r, lib, WITH_CONFIG);

  const ignore = lines(r, '.gitignore');
  assert.ok(ignore.includes('.DS_Store') && ignore.includes('*.lbs'), 'gitignore populated');
  const attrs = lines(r, '.gitattributes');
  assert.ok(attrs.includes('*.tsv diff=cr'), 'ensures *.tsv diff=cr');
  assert.ok(attrs.includes('*.df1 binary'), 'ensures *.df1 binary');
});

test('sets the CR-compatible diff driver in local git config', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  bootstrap(r, lib, WITH_CONFIG);

  const textconv = h.git(r, 'config', '--local', '--get', 'diff.cr.textconv');
  assert.equal(textconv, "tr '\\r' '\\n' <");
});

test('is idempotent: a second run rewrites nothing', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  bootstrap(r, lib, WITH_CONFIG);
  const ignorePath = path.join(r, '.gitignore');
  const attrsPath = path.join(r, '.gitattributes');
  const before = [fs.statSync(ignorePath).mtimeMs, fs.statSync(attrsPath).mtimeMs];

  bootstrap(r, lib, WITH_CONFIG);

  const after = [fs.statSync(ignorePath).mtimeMs, fs.statSync(attrsPath).mtimeMs];
  assert.deepEqual(after, before, 'files untouched on the second run');
});

test('deletes the legacy <lib>.gittools.meta file beside the library', () => {
  const r = h.newRepo(); const lib = h.libOf(r); // <repo>/Lib.lbs
  const legacyMeta = path.join(r, 'Lib.gittools.meta');
  fs.writeFileSync(legacyMeta, 'stale');

  bootstrap(r, lib);

  assert.ok(!fs.existsSync(legacyMeta), 'legacy meta removed');
});

test('deletes the post-commit.d/gittools hook and removes the dir if it is left empty', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const hookDir = path.join(r, '.git', 'hooks', 'post-commit.d');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'gittools'), '#!/bin/sh\n');

  bootstrap(r, lib);

  assert.ok(!fs.existsSync(path.join(hookDir, 'gittools')), 'hook file removed');
  assert.ok(!fs.existsSync(hookDir), 'emptied post-commit.d removed');
});

test('leaves an unrelated hook in post-commit.d and the post-commit dispatcher intact', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const hooksDir = path.join(r, '.git', 'hooks');
  const hookDir = path.join(hooksDir, 'post-commit.d');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'gittools'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(hookDir, 'their-hook'), '#!/bin/sh\necho hi\n');
  fs.writeFileSync(path.join(hooksDir, 'post-commit'), '#!/bin/sh\n# dispatcher\n');

  bootstrap(r, lib);

  assert.ok(!fs.existsSync(path.join(hookDir, 'gittools')), 'our hook removed');
  assert.ok(fs.existsSync(path.join(hookDir, 'their-hook')), "user's hook preserved");
  assert.ok(fs.existsSync(hookDir), 'non-empty post-commit.d preserved');
  assert.ok(fs.existsSync(path.join(hooksDir, 'post-commit')), 'dispatcher left intact');
});

test('deletes the legacy .git/gittools-mapping.meta file', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const mapping = path.join(r, '.git', 'gittools-mapping.meta');
  fs.writeFileSync(mapping, 'stale');

  bootstrap(r, lib);

  assert.ok(!fs.existsSync(mapping), 'legacy mapping file removed');
});

test('a clean repository with no legacy artifacts configures without error', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  assert.doesNotThrow(() => bootstrap(r, lib, WITH_CONFIG));
});

test('does not touch git config or the tracked files when updateRepositoryConfig is false', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  bootstrap(r, lib, { updateRepositoryConfig: false });

  assert.ok(!fs.existsSync(path.join(r, '.gitignore')), '.gitignore not created');
  assert.ok(!fs.existsSync(path.join(r, '.gitattributes')), '.gitattributes not created');
  assert.notEqual(h.gitTry(r, 'config', '--local', '--get', 'diff.cr.textconv').status, 0, 'diff driver not set');
});

test('still removes legacy artifacts when updateRepositoryConfig is false', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const legacyMeta = path.join(r, 'Lib.gittools.meta'); fs.writeFileSync(legacyMeta, 'x');
  const mapping = path.join(r, '.git', 'gittools-mapping.meta'); fs.writeFileSync(mapping, 'x');
  const hookDir = path.join(r, '.git', 'hooks', 'post-commit.d'); fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'gittools'), '#!/bin/sh\n');

  bootstrap(r, lib, { updateRepositoryConfig: false });

  assert.ok(!fs.existsSync(legacyMeta), 'legacy meta removed');
  assert.ok(!fs.existsSync(mapping), 'legacy mapping removed');
  assert.ok(!fs.existsSync(path.join(hookDir, 'gittools')), 'legacy hook removed');
});

test('fails with a structured error when the path is not inside a git repository', () => {
  const outside = h.track(h.tmpName('bootstrap-norepo'));
  fs.mkdirSync(outside, { recursive: true });
  const res = run({
    operation: 'bootstrapRepository',
    jsonPath: path.join(outside, 'Source', 'Lib'),
    libraryPath: path.join(outside, 'Lib.lbs'),
    config: { logLevel: 'error' },
  });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'BAD_REQUEST');
});
