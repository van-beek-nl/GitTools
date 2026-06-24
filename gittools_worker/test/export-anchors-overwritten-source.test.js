// A forced overwrite (no reconciliation base, user proceeds past the gate) is the one export path
// that otherwise leaves no findable base behind. Export-only workflows (the library arrived via a
// commit and was never GitTools-imported) rely on this: without anchoring the committed source it
// overwrites, a later discard back to that committed state raises another false "missing base".

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

test('a forced export anchors the committed source it overwrites, so a later discard-and-export recovers instead of false missing-base', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  // Source arrived via a commit; never imported through GitTools (pure export-only workflow).
  h.commitSource(r, J, { 'a.json': 'S0' }, 'baseline source');
  // First export has no recorded base -> forced overwrite (the user proceeds past the gate).
  h.exportLib(r, J, lib, { 'a.json': 'E1' }, { allowMissingBase: true });
  // The user discards the uncommitted forced export; the live source returns to committed S0.
  h.git(r, 'checkout', '--', J);
  // A routine export must recover against the anchored committed source, not raise missing-base.
  h.omnisExport(r, J, lib, { 'a.json': 'E2' });
  const res = h.runOp('preExport', r, J, lib);
  assert.notEqual(res, 'missing-base', 'the overwritten committed source S0 must be anchored and recoverable');
});

test('the committed source it overwrites is added to the base lineage', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.commitSource(r, J, { 'a.json': 'S0' }, 'baseline source');
  const committed = h.git(r, 'rev-parse', `HEAD:${J}`);
  h.exportLib(r, J, lib, { 'a.json': 'E1' }, { allowMissingBase: true });
  // The base lineage ref must contain the committed tree S0 somewhere in its history.
  const sk = h.stateKey(r, J, lib);
  const lineage = h.git(r, 'rev-list', '--format=%T', '--no-commit-header', `refs/gittools/${sk}/base`).split(/\r?\n/).filter(Boolean);
  assert.ok(lineage.includes(committed), 'the overwritten committed tree is recorded in the base lineage');
});
