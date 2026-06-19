// createContext derives the repository root itself from the (absolute) jsonPath, so Omnis no
// longer passes request.repoRoot. The export root may not exist yet, so resolution probes from
// the nearest existing ancestor (see git.resolveRepoRoot).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createContext } = require('../src/context.js');
const { newRepo, libOf, exportLib, readSrc, J, track } = require('../test-support/helpers.js');

function baseRequest(repo, jsonPath) {
  return { jsonPath, libraryId: 'LIB', libraryPath: libOf(repo), config: { logLevel: 'error' } };
}

test('derives the repository root from an absolute jsonPath, with no request.repoRoot', () => {
  const repo = newRepo('ctx-derive');
  const ctx = createContext(baseRequest(repo, path.join(repo, 'Source', 'Lib'))); // jsonPath not created yet

  assert.strictEqual(ctx.repoRoot, fs.realpathSync(repo));
  assert.strictEqual(ctx.jsonPath, 'Source/Lib');
});

test('rejects a non-absolute jsonPath with BAD_REQUEST', () => {
  const repo = newRepo('ctx-relative');
  assert.throws(
    () => createContext(baseRequest(repo, 'Source/Lib')),
    (err) => err.code === 'BAD_REQUEST'
  );
});

test('rejects a jsonPath outside any repository with BAD_REQUEST', () => {
  const outside = track(path.join(os.tmpdir(), `ctx-outside-${crypto.randomBytes(6).toString('hex')}`));
  fs.mkdirSync(outside, { recursive: true });
  assert.throws(
    () => createContext(baseRequest(outside, path.join(outside, 'Source', 'Lib'))),
    (err) => err.code === 'BAD_REQUEST'
  );
});

test('a full export round-trip works without request.repoRoot', () => {
  const repo = newRepo('ctx-export');
  exportLib(repo, J, libOf(repo), { 'a.tsv': 'one' });

  assert.deepStrictEqual(readSrc(repo, J), { 'a.tsv': 'one' });
});
