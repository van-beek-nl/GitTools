// resolveRepoRoot derives a library's repository root from its (possibly not-yet-existing)
// jsonPath, the way registration needs it: walk up to the nearest existing ancestor, then ask
// git for the work-tree top level. Not being in a repository is a normal answer ('') rather
// than an error, so Omnis can skip registration with a friendly warning.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createGit } = require('../src/git.js');
const { newRepo, track } = require('../test-support/helpers.js');

test('resolves the repo root from a jsonPath that does not exist yet', () => {
  const repo = newRepo('resolve');
  const jsonPath = path.join(repo, 'Source', 'Lib'); // never created

  assert.strictEqual(createGit().resolveRepoRoot(jsonPath), fs.realpathSync(repo));
});

test('returns an empty string when the path is not inside a repository', () => {
  const outside = track(path.join(os.tmpdir(), `resolve-none-${crypto.randomBytes(6).toString('hex')}`));
  fs.mkdirSync(outside, { recursive: true });

  assert.strictEqual(createGit().resolveRepoRoot(path.join(outside, 'Source', 'Lib')), '');
});
