// Resolving vs discarding an export conflict, and how each affects the recorded base.
// The "continuation" cases cover the hard variant: a clean MERGE export leaves GitTools'
// merged output uncommitted, then a second export conflicts against that uncommitted output,
// so the recorded source is not reachable by restoring to HEAD and the resolve-vs-discard
// decision cannot be made by tree equality against HEAD alone.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers');
const { J } = h;

test('committing a conflict resolution advances the base so the next export is clean', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'import');
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'bMOD' }, 'colleague edits b');
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0' }), 'conflict', 'export deleting b conflicts');
  // Resolve by accepting the deletion and committing it.
  h.gitTry(r, 'rm', '-q', `${J}/b.json`);
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'resolve: accept deletion');
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0' }), 'clean', 'the resolved export no longer conflicts');
  const m = h.readMeta(r, J, lib);
  assert.ok(m.status === 'clean' && !m.pending, 'no pending state remains');
});

test('discarding a conflict without resolving it reproduces the conflict on the next export', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'import');
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'bMOD' }, 'colleague edits b');
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0' }), 'conflict', 'export deleting b conflicts');
  h.git(r, 'restore', '--source=HEAD', '--staged', '--worktree', '--', J);
  h.git(r, 'clean', '-fdq', '--', J);
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0' }), 'conflict', 'the unresolved situation conflicts again');
});

test('discarding a continuation conflict re-surfaces it rather than silently dropping library work', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });                 // base = {a0,b0}
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'bC' }, 'colleague edits b'); // HEAD = {a0,bC}
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'b0' }), 'clean', 'clean merge, output left uncommitted'); // live {aX,bC}
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bY' }), 'conflict', 'second export conflicts on b'); // bC vs bY
  // Discard to HEAD ({a0,bC}); the uncommitted merged output is gone, so this lands off the
  // continuation lineage.
  h.gitTry(r, 'restore', '--source=HEAD', '--staged', '--worktree', '--', J);
  h.gitTry(r, 'clean', '-fdq', '--', J);
  assert.equal(h.read1(r, J, 'a.json'), 'a0', 'discard restored a to a0');
  // Re-export the same library. The correct three-way against the true base {a0,b0} keeps the
  // developer's a=aX and conflicts on b, instead of swallowing the change.
  const res = h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bY' });
  assert.equal(res, 'conflict', 'the conflict is re-surfaced, not swallowed');
  assert.equal(h.read1(r, J, 'a.json'), 'aX', "the developer's library change to a survives");
  assert.equal(h.stat(r, `${J}/b.json`), 'UU', 'b is left as a real modify/modify conflict');
});

test('accepting and committing a continuation conflict advances the base with no spurious re-conflict', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'bC' }, 'colleague edits b');
  h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'b0' });                  // clean merge -> live {aX,bC}, uncommitted
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bY' }), 'conflict', 'second export conflicts on b');
  // Resolve by accepting the export side and committing it.
  h.commitSource(r, J, { 'a.json': 'aX', 'b.json': 'bY' }, 'resolve: accept export');
  // The export is now absorbed, so the base advanced to it: re-exporting it must be clean.
  const res = h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bY' });
  assert.equal(res, 'clean', 'an accepted export does not re-conflict');
  assert.equal(h.read1(r, J, 'a.json'), 'aX', 'a == aX');
  assert.equal(h.read1(r, J, 'b.json'), 'bY', 'b == bY');
});
