// Regression (omnis_20260728.log): a DISCARDED export conflict must never be treated as accepted.
// Taking the export tree as the base there makes every later merge resolve to HEAD, so no library
// change reaches git again.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

test('a conflict that was discarded (not resolved) must not advance the base past the library', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'bC' }, 'colleague edits b');

  // A clean three-way merge: the library's a wins, the colleague's b survives. This is what
  // leaves base != source -- base is the raw export, source is the merged working tree.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'b0' }), 'clean', 'export merges cleanly');
  const merged = h.readMeta(r, J, lib);
  assert.notEqual(merged.baseTree, merged.sourceTree, 'precondition: a merging export leaves base != source');

  // Now the library edits b as well, colliding with the colleague's value.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bZ' }), 'conflict',
    'the library and the colleague both moved b');

  // HEAD moves out from under the pending conflict (a pull that reverts both files).
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'b0' }, 'colleague reverts both files');

  // Re-export the SAME library.
  h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bZ' });

  // Nothing accepted the export, so the library's content must reach the working tree.
  assert.equal(h.read1(r, J, 'a.json'), 'aX', "the library's a reaches the working tree");
  assert.equal(h.read1(r, J, 'b.json'), 'bZ', "the library's b reaches the working tree");

  // And it must not be a one-off: with the base wrongly advanced, the loss was permanent.
  h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bZ' });
  assert.equal(h.read1(r, J, 'a.json'), 'aX', 'still present after a further export');
});

// The contract for discarding a resolved-but-uncommitted conflict: export writes the library over
// the export tree, and a hand-merge that was never imported is not part of the library, so
// discarding it is legitimate. What makes that safe rather than lossy is that the disagreement it
// resolved must COME BACK -- the export may not quietly settle it in either direction.
test('a hand-merged but uncommitted resolution is discarded, and the conflict comes back', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'bC' }, 'colleague edits b');

  // The library edits the same file the colleague committed.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'bY' }), 'conflict',
    'library bY collides with the colleague bC');

  // The developer hand-merges to a third value and stages it, but does not commit.
  h.writeFiles(`${r}/${J}`, { 'b.json': 'bBOTH' });
  h.git(r, 'add', '-A');

  const res = h.exportLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'bY' });

  assert.equal(res, 'conflict', 'the disagreement re-surfaces instead of being settled silently');
  assert.equal(h.stat(r, `${J}/b.json`), 'UU', 'b is a real unmerged conflict again');
  assert.notEqual(h.read1(r, J, 'b.json'), 'bC', "the colleague's value did not silently win");
});

// The other half of the contract: the tree comparison must not be so strict that a real
// resolution stops counting. Resolving in the user's Git client and committing is the route the
// conflict message tells them to take, and it must be recognised as acceptance.
test('a genuinely resolved conflict is still recognised and still advances the base', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' });
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'bC' }, 'colleague edits b');

  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bY' }), 'conflict',
    'the library and the colleague both moved b');
  const pendingExport = h.readMeta(r, J, lib).pending.exportTree;

  // Resolve in favour of the export and commit, exactly as the conflict message instructs.
  h.commitSource(r, J, { 'a.json': 'aX', 'b.json': 'bY' }, 'resolve in favour of the export');

  const res = h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bY' });
  assert.equal(res, 'clean', 'the accepted export does not re-conflict');
  assert.equal(h.readMeta(r, J, lib).baseTree, pendingExport, 'the base advanced to the export tree');
  assert.equal(h.read1(r, J, 'a.json'), 'aX', 'the resolution is preserved');
  assert.equal(h.read1(r, J, 'b.json'), 'bY', 'the resolution is preserved');
});
