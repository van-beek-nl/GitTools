// Three-way reconciliation outcomes: how an Omnis export is merged against a committed
// source that has diverged from GitTools' recorded base.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

test('an export that matches the just-imported source stays clean', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const res = h.importLib(r, J, lib, { 'a.json': 'a0' });
  assert.equal(res, 'clean', 'post-import is clean');
  const m = h.readMeta(r, J, lib);
  assert.ok(m.baseTree && m.baseTree === m.sourceTree, 'import records base == source');
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0' }), 'clean', 'identical content reconciles cleanly');
});

test('a clean merge preserves a file a colleague added that the export does not include', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'import');
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'b0', 'c.json': 'c1' }, 'colleague adds c');
  const res = h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' }); // export lacks c
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean', 'disjoint change merges cleanly');
  assert.equal(f['c.json'], 'c1', "colleague's added file is preserved");
  assert.ok('a.json' in f && 'b.json' in f, 'existing files remain');
});

test('a library deletion that collides with a colleague edit surfaces as a conflict', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'import');
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'bMOD' }, 'colleague edits b');
  const res = h.exportLib(r, J, lib, { 'a.json': 'a0' }); // export deletes b
  assert.equal(res, 'conflict', 'delete/modify is a conflict');
  assert.ok(h.hasConflict(r, J), 'the conflict is left unresolved in the working tree');
});

test('repeated exports before committing reconcile cleanly instead of raising a false conflict', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'a.json': 'a0' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'init');
  h.exportLib(r, J, lib, { 'a.json': 'a1' });             // first export, left uncommitted
  const res = h.exportLib(r, J, lib, { 'a.json': 'a2' }); // second export over the first
  assert.equal(res, 'clean', 'a continuation export does not conflict with its own prior output');
  assert.equal(h.readSrc(r, J)['a.json'], 'a2', 'the latest export wins');
});
