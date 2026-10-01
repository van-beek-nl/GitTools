// Regression (PionUs report, omnis_20260701.log): a second export after pulling a peer's commit,
// with the first export left uncommitted and then discarded, must not drop the peer's work.

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
