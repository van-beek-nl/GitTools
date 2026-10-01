// A library change that was exported but not committed must survive the next export instead of
// being reverted to HEAD (field report 2026-07-30), while a peer's committed work is never dropped.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const h = require('../test-support/helpers');
const { J } = h;

test('an exported-but-uncommitted library change is not reverted to HEAD by the next export', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  h.importLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v0' });

  // The developer does a round of work the normal way: export, review, commit. HEAD's t.json is
  // now content the library itself produced, so it is in the lineage.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1' }), 'clean');
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'commit exported v1');

  // They keep working and export a small follow-up tweak, but do not commit it yet.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1+TEST' }), 'clean');
  assert.equal(h.read1(r, J, 't.json'), 'v1+TEST', 'the tweak reached the working tree');

  // Anything that moves the working tree off GitTools' last output puts the next export on the
  // drift path -- here a discard, but a pull or a checkout does the same.
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);

  // Export again. The library still holds the tweak, so the working tree must show it. Before the
  // fix this silently reverted to 'v1': the base already contained '+TEST', so the merge concluded
  // the library had changed nothing and kept HEAD.
  const res = h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1+TEST' });
  assert.equal(res, 'clean', 'reconciles cleanly');
  assert.equal(h.read1(r, J, 't.json'), 'v1+TEST', "the library's uncommitted tweak survives the export");
});

test('a discarded export colliding with a peer commit on the same file conflicts', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v0' });
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1' }), 'clean');

  // Discarding in git leaves v1 in the library, so it comes back; the peer's edit must not win silently.
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);
  h.commitSource(r, J, { 'a.json': 'a0', 't.json': 'peer' }, 'teammate edits t');

  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1' }), 'conflict');
  assert.equal(h.stat(r, `${J}/t.json`), 'UU');
  const t = h.read1(r, J, 't.json');
  assert.ok(t.includes('peer') && t.includes('v1'), 'both versions are kept in the conflict');
});

test('a discarded export colliding with a fast-forwarded peer commit conflicts', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'x.json': 'x0' }, { clear: true });
  const branch = h.git(r, 'symbolic-ref', '--short', 'HEAD');
  const importCommit = h.git(r, 'rev-parse', 'HEAD');

  h.exportLib(r, J, lib, { 'a.json': 'a1', 'x.json': 'x0' });
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);

  h.git(r, 'branch', 'peer', importCommit);
  h.git(r, 'checkout', '-q', 'peer');
  fs.writeFileSync(path.join(r, J, 'a.json'), 'a2');
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'peer a2');
  h.git(r, 'checkout', '-q', branch);
  h.git(r, 'merge', '-q', 'peer');

  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a1', 'x.json': 'x0' }), 'conflict');
  assert.equal(h.stat(r, `${J}/a.json`), 'UU');
  assert.equal(h.read1(r, J, 'x.json'), 'x0');
});

test('an unavailable base lineage degrades to protecting committed content, not to overwriting it', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  // The lineage is never pushed, so a fresh clone or pruned ref has none. Without it the last
  // export is the only known library output; unknown origin must never read as "the library owns it".
  h.importLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v0' });
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1' }), 'clean');
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'commit exported v1');
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1+TEST' }), 'clean');
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);

  h.git(r, 'update-ref', '-d', `refs/gittools/${h.stateKey(r, J, lib)}/base`);
  assert.equal(h.baseRefTarget(r, J, lib), '', 'the lineage is gone');

  const res = h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1+TEST' });
  assert.equal(res, 'clean', 'a missing lineage is not an error');
  assert.equal(h.read1(r, J, 't.json'), 'v1', 'falls back to HEAD rather than overwriting it blindly');
});
