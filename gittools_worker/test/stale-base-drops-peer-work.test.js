// Regression: the base recovery must not "stick" to the last import base.
//
// When the live JSON path drifts (the dev pulled a peer's commits) and the dev did not
// commit GitTools' merged output verbatim, pre-export recomputes the merge base by walking
// HEAD's committed history. Export bases are never committed (only import bases are), so that
// walk skips every base recorded since the last import and collapses to the import base.
// Merging the current library against that stale base re-surfaces the dev's own already-synced
// work as a conflict and discards the peer's interleaved committed change.
//
// The true last-sync base is still recorded (it is meta.baseTree and lives in the base
// lineage); the export must reconcile against it, which is a clean merge that keeps the peer's
// change. See bug-report/ (PionUs/AI_tests) and memory/stale-base-drops-peer-work.md.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

const NL = '\n';
const lines = (...a) => a.join(NL) + NL;

test('an export after pulling a peer commit reconciles against the true last sync, not the stale import base', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  // Last import: the baseline. shared.json is co-edited by dev and peer; devwork.json only
  // the dev edits; peerwork.json only the peer edits.
  h.importLib(r, J, lib, {
    'shared.json':   lines('L1', 'L2', 'L3'),
    'devwork.json':  lines('D0'),
    'peerwork.json': lines('P0'),
  }, { clear: true });

  // Session 1: the dev exports their own work (devwork D0->D1, shared L2->L2-dev). Their
  // library still carries the original peer content. This records a base in the lineage.
  assert.equal(h.exportLib(r, J, lib, {
    'shared.json':   lines('L1', 'L2-dev', 'L3'),
    'devwork.json':  lines('D1'),
    'peerwork.json': lines('P0'),
  }), 'clean');

  // The dev does NOT commit GitTools' output verbatim. Instead two peer pulls land and get
  // committed on top of it: peerwork P0->P1->P2, shared L1->L1-peer, and shared L2-dev->L2-peer
  // (the peer edits the very line the dev synced in session 1).
  h.commitSource(r, J, {
    'shared.json':   lines('L1-peer', 'L2-dev', 'L3'),
    'devwork.json':  lines('D1'),
    'peerwork.json': lines('P1'),
  }, 'peer: P1 + shared L1', { clear: true });
  h.commitSource(r, J, {
    'shared.json':   lines('L1-peer', 'L2-peer', 'L3'),
    'devwork.json':  lines('D1'),
    'peerwork.json': lines('P2'),
  }, 'peer: P2 + shared L2', { clear: true });

  // Session 2: the dev exports again (devwork D1->D2). Their library evolved from session 1 and
  // still has no peer content. Relative to the dev's TRUE last sync, the only library change is
  // devwork D1->D2; the peer's shared/peerwork edits are disjoint, so this must merge cleanly.
  const res = h.exportLib(r, J, lib, {
    'shared.json':   lines('L1', 'L2-dev', 'L3'),
    'devwork.json':  lines('D2'),
    'peerwork.json': lines('P0'),
  });

  const f = h.readSrc(r, J);
  assert.equal(res, 'clean', 'reconciles cleanly against the true last sync (not a stale-base conflict)');
  assert.equal(h.hasConflict(r, J), false, 'no conflict left in the working tree');
  assert.equal(f['devwork.json'], lines('D2'), "the dev's new work is applied without re-conflicting their own synced work");
  assert.equal(f['shared.json'], lines('L1-peer', 'L2-peer', 'L3'), "the peer's shared.L1/L2 changes are preserved");
  assert.equal(f['peerwork.json'], lines('P2'), "the peer-only change is preserved");
});
