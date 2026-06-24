// Imports routinely run over uncommitted source (Omnis can only export/import the whole library
// at once, so the live JSON usually carries pending work). post-import must record a STABLE base
// that a later export can re-find from history — not the dirty, never-committed live tree, which
// would surface as a false "missing base" once the live source drifts back.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../test-support/helpers');
const { J } = h;

test('importing over uncommitted source records the committed tree as the base, so a later export recovers instead of false missing-base', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  // The library's source arrived as a commit; GitTools has never imported it in this clone.
  h.commitSource(r, J, { 'a.json': 'S0' }, 'baseline source');
  // The user has uncommitted edits in the live source at import time (the common case).
  fs.writeFileSync(path.join(r, J, 'a.json'), 'DIRTY');
  h.runOp('postImport', r, J, lib);
  // They discard the uncommitted edits (export-over / discard workflow); live returns to S0.
  h.git(r, 'checkout', '--', J);
  // A routine export must reconcile against the committed base S0, NOT raise missing-base.
  h.omnisExport(r, J, lib, { 'a.json': 'NEW' });
  const res = h.runOp('preExport', r, J, lib);
  assert.notEqual(res, 'missing-base', 'the committed source S0 must be a recoverable base');
});

test('a clean import records the committed source tree as the base', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'S0' });
  const meta = h.readMeta(r, J, lib);
  const committed = h.git(r, 'rev-parse', `HEAD:${J}`);
  assert.equal(meta.baseTree, committed, 'base is the committed source tree');
  const baseRefTree = h.git(r, 'rev-parse', `${h.baseRefTarget(r, J, lib)}^{tree}`);
  assert.equal(baseRefTree, committed, 'the base lineage ref points at the committed source tree');
});
