// Regression: a second export after pulling a peer's commit must not drop the peer's work.
//
// The scenario (from the PionUs bug report, bug-report/omnis_20260701.log):
//  - The dev imports the baseline, then PULLS a peer commit, so the peer's work is on HEAD
//    *before* the dev exports. The dev's library still carries the old (pre-pull) content.
//  - Export #1 reconciles correctly: the peer's committed change is behind the recorded sync
//    commit, so it three-way merges in and survives on disk. But post-export then advances
//    meta.syncCommit to the pulled HEAD, even though the library was never imported from it.
//  - The dev exports again without committing, on the "live path drifted" branch (a discard
//    here). Now syncCommit == HEAD, so the reconciliation base sees no committed work since the
//    sync, collapses to HEAD, and post-export applies the raw library export (which lacks the
//    peer's work) directly over the live path — deleting the peer's pulled change.
//
// The peer's committed change must survive the second export exactly as it did the first.
// See memory/second-export-collapses-reconciliation-base.md.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

const NL = '\n';
const lines = (...a) => a.join(NL) + NL;

test('a second export after pulling a peer commit (no commit in between) keeps the peer work', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  // Import baseline. peerwork.json is only ever edited by the peer; devwork.json only by the dev.
  h.importLib(r, J, lib, {
    'devwork.json':  lines('D0'),
    'peerwork.json': lines('P0'),
  }, { clear: true });

  // The dev PULLS a peer commit: peerwork P0->P1 lands on HEAD before the dev exports. (git
  // refuses a pull that would clobber an uncommitted export, so this legitimately precedes the
  // dev's first export.)
  h.commitSource(r, J, {
    'devwork.json':  lines('D0'),
    'peerwork.json': lines('P1'),
  }, 'peer: peerwork P1 (pulled)', { clear: true });

  // Export #1: the dev exports their own work (devwork D0->D1). Their library has no peer
  // content. This reconciles cleanly and must keep the peer's pulled change.
  assert.equal(h.exportLib(r, J, lib, {
    'devwork.json':  lines('D1'),
    'peerwork.json': lines('P0'),
  }), 'clean');
  assert.equal(h.readSrc(r, J)['peerwork.json'], lines('P1'), 'peer work present after the first export');

  // The dev discards the uncommitted export (a documented "live path drifted" trigger) — HEAD is
  // unchanged and still carries the peer's committed change.
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);

  // Export #2, still no commit in between: the dev re-exports the same library (devwork D1, no
  // peer content). Relative to the dev's TRUE last sync the only change is devwork; the peer's
  // committed peerwork edit is disjoint, so this must merge cleanly and keep it.
  const res = h.exportLib(r, J, lib, {
    'devwork.json':  lines('D1'),
    'peerwork.json': lines('P0'),
  });

  const f = h.readSrc(r, J);
  assert.equal(res, 'clean', 'reconciles cleanly against the true last sync');
  assert.equal(h.hasConflict(r, J), false, 'no conflict left in the working tree');
  assert.equal(f['devwork.json'], lines('D1'), "the dev's work is applied");
  assert.equal(f['peerwork.json'], lines('P1'), "the peer's pulled change is NOT dropped by the second export");
});
