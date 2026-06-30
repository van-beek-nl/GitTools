// The drift path builds the merge base from the commit graph using the recorded sync commit:
// changes that reached committed history since the sync are kept, working-tree discards are not.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const h = require('../test-support/helpers');
const { J } = h;

test('post-import records the current HEAD as the sync commit', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' }, { clear: true });
  assert.equal(h.readMeta(r, J, lib).syncCommit, h.git(r, 'rev-parse', 'HEAD'));
});

test('post-export records the HEAD it reconciled against as the sync commit', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0' }, { clear: true });
  const head = h.git(r, 'rev-parse', 'HEAD');               // export does not commit, so HEAD stays here
  h.exportLib(r, J, lib, { 'a.json': 'a1' });
  assert.equal(h.readMeta(r, J, lib).syncCommit, head);
});

test("a teammate's committed change is kept even when the library value was discarded for that file", () => {
  // Reaching this state requires discarding first: git refuses a pull that would clobber the
  // uncommitted export. So the developer set their value aside, and the teammate's committed
  // change must win (we never drop committed work); the discard does not resurface for that file.
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'x.json': 'x0' }, { clear: true });
  const branch = h.git(r, 'symbolic-ref', '--short', 'HEAD');
  const importCommit = h.git(r, 'rev-parse', 'HEAD');

  h.exportLib(r, J, lib, { 'a.json': 'a1', 'x.json': 'x0' });          // export a1 (uncommitted)
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);         // discard a1 back to a0

  h.git(r, 'branch', 'peer', importCommit);
  h.git(r, 'checkout', '-q', 'peer');
  fs.writeFileSync(path.join(r, J, 'a.json'), 'a2');                    // teammate's independent change
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'peer a2');
  h.git(r, 'checkout', '-q', branch);
  h.git(r, 'merge', 'peer');                                           // fast-forward; HEAD has a2

  const res = h.exportLib(r, J, lib, { 'a.json': 'a1', 'x.json': 'x0' }); // library still carries a1
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean');
  assert.equal(f['a.json'], 'a2', "the teammate's committed change wins for the discarded file");
});
