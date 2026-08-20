// The clearExportCache escape hatch: empty the export cache so the next export rebuilds the
// library in full.
//
// It exists because Omnis' $exportjson is incremental -- it only rewrites the classes it considers
// changed -- so a cache entry that has gone stale in a way Omnis cannot see (an edit not yet
// committed to the class in the IDE) keeps producing the same wrong export tree no matter how many
// times the developer re-exports. Nothing GitTools can inspect tells a stale entry from a correct
// one: the class is present, just wrong. Hence a manual hatch rather than an automatic guard.
//
// The safety property under test is what it must NOT delete. meta.json and pending-op.json share
// the state directory with the cache but are reconciliation state, not build output: losing them
// discards the record of what git and the library last agreed on.

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

test('clearing removes the cache and its index, and the next export rebuilds in full', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' });
  h.exportLib(r, J, lib, { 'a.json': 'a1' });

  const cache = h.cacheDir(r, J, lib);
  const index = `${cache}.index`;
  assert.ok(fs.existsSync(cache) && fs.existsSync(index), 'precondition: an export cache exists');

  const res = h.runOp('clearExportCache', r, J, lib);
  assert.equal(res, 'clean');
  assert.equal(fs.existsSync(cache), false, 'the cache directory is gone');
  assert.equal(fs.existsSync(index), false, 'the cache index is gone');

  // The library still exports correctly afterwards; pre-export recreates what it needs.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a2' }), 'clean', 'the next export still works');
  assert.equal(h.read1(r, J, 'a.json'), 'a2', "the library's content is applied");
});

test('clearing preserves the reconciliation state that shares the directory', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' });
  h.exportLib(r, J, lib, { 'a.json': 'a1' });

  const before = h.readMeta(r, J, lib);
  const lineageBefore = h.baseRefTarget(r, J, lib);
  assert.ok(before.baseTree && lineageBefore, 'precondition: base state was recorded');

  h.runOp('clearExportCache', r, J, lib);

  assert.deepEqual(h.readMeta(r, J, lib), before, 'meta.json is untouched');
  assert.equal(h.baseRefTarget(r, J, lib), lineageBefore, 'the base lineage is untouched');
});

test('clearing a cache that is not there is not an error', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' });

  assert.equal(h.runOp('clearExportCache', r, J, lib), 'clean', 'a missing cache is a no-op, not a failure');
});

test('clearing is safe while an export conflict is pending', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'bC' }, 'colleague edits b');
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'bY' }), 'conflict');

  h.runOp('clearExportCache', r, J, lib);

  // The pending conflict survives: it lives in meta and the worktree refs, not in the cache.
  assert.equal(h.readMeta(r, J, lib).status, 'pendingExportConflict', 'the pending conflict is intact');
  assert.equal(h.pendingExists(r, J, lib), true, 'the pending refs are intact');
});

test('the handoff of an in-flight export is left alone', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' });

  // Mid-export: pre-export has run and written the handoff, Omnis has not finished writing yet.
  h.omnisExport(r, J, lib, { 'a.json': 'a1' });
  h.runOp('preExport', r, J, lib);
  const handoff = h.handoffPath(r, J, lib);
  assert.ok(fs.existsSync(handoff), 'precondition: a handoff is pending');

  h.runOp('clearExportCache', r, J, lib);
  assert.ok(fs.existsSync(handoff), 'the in-flight handoff is not collateral damage');
});
