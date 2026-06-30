// Everyday Omnis workflows over the per-file reconciliation base: partial commits/discards,
// stashes, re-exporting over uncommitted output, and teammates adding/deleting files. Omnis
// exports the whole library at once, so unready WIP and not-yet-imported teammate work routinely
// coexist on disk; these pin down what each export should produce.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const h = require('../test-support/helpers');
const { J } = h;

function write(r, rel, content) { fs.writeFileSync(path.join(r, J, rel), content); }

test('partial commit + partial discard + a pulled change reconcile per file', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0', 'c.json': 'c0' }, { clear: true });
  h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b1', 'c.json': 'c0' });
  h.git(r, 'add', `${J}/a.json`); h.git(r, 'commit', '-q', '-m', 'commit a1 only'); // a committed, b1 still WIP
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', `${J}/b.json`);          // discard b back to b0
  write(r, 'c.json', 'cP'); h.git(r, 'add', `${J}/c.json`); h.git(r, 'commit', '-q', '-m', 'pull: c -> cP');

  const res = h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b1', 'c.json': 'c0' }); // library: a1, b1, old c0
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean');
  assert.equal(f['a.json'], 'a1', 'committed file unchanged');
  assert.equal(f['b.json'], 'b1', 'discarded WIP resurfaces from the library');
  assert.equal(f['c.json'], 'cP', 'the pulled change is kept');
});

test('the normal export -> commit -> export loop stays clean', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' }, { clear: true });
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a1' }), 'clean');
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'commit export 1');
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a2' }), 'clean');
  assert.equal(h.read1(r, J, 'a.json'), 'a2');
});

test('re-exporting changed content over uncommitted output applies the new content', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' }, { clear: true });
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a1' }), 'clean');
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a2' }), 'clean'); // re-export, still uncommitted
  assert.equal(h.read1(r, J, 'a.json'), 'a2');
});

test('re-exporting identical content over uncommitted output is a clean no-op', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' }, { clear: true });
  h.exportLib(r, J, lib, { 'a.json': 'a1' });
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a1' }), 'clean');
  assert.equal(h.read1(r, J, 'a.json'), 'a1');
});

test("a teammate's newly committed file survives an export that does not include it", () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' }, { clear: true });
  write(r, 'z.json', 'z0'); h.git(r, 'add', `${J}/z.json`); h.git(r, 'commit', '-q', '-m', 'pull: add z');

  const res = h.exportLib(r, J, lib, { 'a.json': 'a1' }); // library has no z
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean');
  assert.equal(f['a.json'], 'a1');
  assert.equal(f['z.json'], 'z0', "the teammate's new file is not dropped");
});

test("a teammate's committed deletion propagates even though the library still has the file", () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' }, { clear: true });
  h.git(r, 'rm', '-q', `${J}/b.json`); h.git(r, 'commit', '-q', '-m', 'pull: delete b');

  const res = h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b0' }); // library still has b
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean');
  assert.equal(f['a.json'], 'a1');
  assert.ok(!('b.json' in f), "the teammate's deletion of b is respected");
});

test("a teammate's deletion of a file the library also modified is a conflict", () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' }, { clear: true });
  h.git(r, 'rm', '-q', `${J}/b.json`); h.git(r, 'commit', '-q', '-m', 'pull: delete b');

  // The library MODIFIED b (b0 -> b2): remote-delete vs local-modify must not silently resolve.
  const res = h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b2' });
  assert.equal(res, 'conflict', 'remote-delete vs local-modify surfaces as a conflict');
  assert.ok(h.hasConflict(r, J), 'the conflict is left for the user to resolve');
});

test('a stashed export resurfaces on re-export while a pulled change is kept', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' }, { clear: true });
  h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b0' }); // export a1 (uncommitted)
  h.git(r, 'stash');                                          // set the export aside (working tree -> HEAD)
  write(r, 'b.json', 'bP'); h.git(r, 'add', `${J}/b.json`); h.git(r, 'commit', '-q', '-m', 'pull: b -> bP');

  const res = h.exportLib(r, J, lib, { 'a.json': 'a1', 'b.json': 'b0' }); // library: a1, old b0
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean');
  assert.equal(f['a.json'], 'a1', 'stashed library change resurfaces');
  assert.equal(f['b.json'], 'bP', 'the pulled change is kept');
});

test('a genuine concurrent edit conflicts rather than silently merging', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'v0' }, { clear: true });
  const branch = h.git(r, 'symbolic-ref', '--short', 'HEAD');
  const importCommit = h.git(r, 'rev-parse', 'HEAD');
  h.exportLib(r, J, lib, { 'a.json': 'v1' });                       // export v1 (uncommitted)
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);      // discard v1 (so the pull is clean)
  h.git(r, 'branch', 'peer', importCommit); h.git(r, 'checkout', '-q', 'peer');
  write(r, 'a.json', 'v2'); h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'peer v2');
  h.git(r, 'checkout', '-q', branch); h.git(r, 'merge', 'peer');    // fast-forward; HEAD has v2

  const res = h.exportLib(r, J, lib, { 'a.json': 'v3' });           // library evolved to v3
  assert.equal(res, 'conflict', 'committed v2 vs library v3 is a real conflict');
});

test('the per-file base handles nested paths and names with spaces', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const wip = 'My Class/methods.json';
  const pulled = 'My Class/sub item/object.json';
  h.importLib(r, J, lib, { [wip]: 'w0', [pulled]: 'p0', 'keep.json': 'k0' }, { clear: true });
  h.exportLib(r, J, lib, { [wip]: 'w1', [pulled]: 'p0', 'keep.json': 'k0' });   // dev edits the nested WIP file
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', `${J}/${wip}`);      // discard the WIP file
  write(r, pulled, 'pP'); h.git(r, 'add', `${J}/${pulled}`); h.git(r, 'commit', '-q', '-m', 'pull: nested change');

  const res = h.exportLib(r, J, lib, { [wip]: 'w1', [pulled]: 'p0', 'keep.json': 'k0' }); // library: w1, old p0
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean');
  assert.equal(f[wip], 'w1', 'discarded nested WIP resurfaces');
  assert.equal(f[pulled], 'pP', 'pulled nested change is kept');
});
