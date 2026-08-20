// Regression: a DISCARDED export conflict must never be recorded as an ACCEPTED one.
//
// From a field report (omnis_20260728.log, 12:04 -> 12:07). resolvePendingConflict discards
// uncommitted work by restoring the JSON path to HEAD, then decides "did the user accept the
// export?" by replaying the conflicting three-way merge. When the discard lands the source
// exactly on pending.baseTree, that replay degenerates: a merge whose base equals one side can
// never conflict, it just returns the other side. GitTools read that guaranteed-clean exit as
// proof of acceptance and advanced the base to the export tree.
//
// Advancing the base there is unrecoverable: from then on base == exportTree, so every later
// merge is (base=X, ours=HEAD, theirs=X), which resolves to `ours` and writes nothing. The
// library's content can never reach git again. In the field this showed up as "no more changed
// files from the codebase" and exports that silently did nothing.
//
// Reaching the replay at all needs a pending conflict whose source side is NOT what the working
// tree settles on. postImport used to hand that over on a plate, by recording HEAD's committed tree
// as the base while the live tree was the source; that mismatch was itself a bug and is fixed, so
// the route below builds the state the way it still arises: an export that merges cleanly leaves
// base = the raw export tree and source = the merged result, and the next export conflicts against
// that source. HEAD then moves out from under the pending conflict.

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

  // HEAD moves out from under the pending conflict (a pull that reverts both files). The working
  // tree now sits on a state that is neither pending.sourceTree nor pending.exportTree, so the
  // replay runs -- and it merges CLEANLY, because each side's change is unopposed there. A clean
  // exit is therefore no evidence at all that the user accepted the export.
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'b0' }, 'colleague reverts both files');

  // Re-export the SAME library.
  h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'bZ' });

  // Nothing accepted the export, so the base must not have advanced to it: the library is still
  // the only authority for both files and its content must reach the working tree. Reading the
  // replay's clean exit as acceptance instead produced base == exportTree, after which every
  // merge resolved to `ours` and wrote nothing -- here, 'a0' and 'b0' forever.
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
