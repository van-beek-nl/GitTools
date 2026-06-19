// checkGitExecutable lets Omnis validate the user-configured git executable path before
// relying on it: it runs `git --version` and reports whether the path is a working git.
// An unusable path is a normal answer ({ valid: false }), never a worker crash.

const { test } = require('node:test');
const assert = require('node:assert');

const { run } = require('../src/core.js');

test('reports the configured git as valid with its version number (no "git version " prefix)', () => {
  const res = run({ operation: 'checkGitExecutable', config: { gitPath: 'git', logLevel: 'error' } });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.operation, 'checkGitExecutable');
  assert.strictEqual(res.valid, true);
  assert.doesNotMatch(res.version, /^git version /);
  assert.match(res.version, /^\d+\.\d+/);
});

test('reports an unusable git path as invalid without failing the operation', () => {
  const res = run({ operation: 'checkGitExecutable', config: { gitPath: '/nonexistent/definitely-not-git', logLevel: 'error' } });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.valid, false);
});
