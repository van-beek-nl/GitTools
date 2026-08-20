// Imports routinely run over uncommitted source (Omnis can only export/import the whole library
// at once, so the live JSON usually carries an export that has not been committed yet). What
// post-import records for that case has to satisfy two things at once:
//
//   1. The base must be the tree the library actually holds — the tree Omnis imported FROM. Post-
//      export three-way merges (base, source, export) with source = that same live tree, so a base
//      the library never held turns the developer's own uncommitted work into a competing edit on
//      both sides, and every re-export over it conflicts.
//   2. A later export must still be able to RECOVER a base after HEAD moves off the line we synced
//      against (reset, branch switch). That recovery scans HEAD's committed subtrees, which a
//      never-committed live tree is not among.
//
// Recording the live tree as the base satisfies (1); additionally anchoring the committed tree in
// the base lineage satisfies (2).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../test-support/helpers');
const { J } = h;

// The reported bug (logs.log, 20/08/2026 08:14 -> 08:15). Import reads the live JSON tree back
// into the library, so the library IS that tree; recording HEAD's committed tree as the base
// instead claimed otherwise, and the very next export three-way merged the developer's own
// uncommitted work against itself. In the field: "exporting my work over uncommitted previous
// work keeps creating merge conflicts."
test('exporting after an import over uncommitted source does not conflict with the developer\'s own work', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'v0' });

  // Export, do not commit -- the live JSON path now carries uncommitted GitTools output.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'v1' }), 'clean', 'first export');

  // Import that uncommitted tree back into the library (the GitTools self-development loop, and
  // any "import to test what I just exported" round trip).
  h.runOp('postImport', r, J, lib);
  const meta = h.readMeta(r, J, lib);
  assert.equal(meta.baseTree, meta.sourceTree,
    'the library holds the tree it was imported from, so base and source must agree');

  // Change one more thing and export again. This is the developer exporting over their own
  // uncommitted work, which is theirs to overwrite -- it must not raise a conflict.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'v2' }), 'clean', 'export after import');
  assert.equal(h.read1(r, J, 'a.json'), 'v2', "the library's content is applied");
});

test('importing over uncommitted source still leaves a recoverable base, so a later export does not raise a false missing-base', () => {
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

// The committed tree is anchored in the lineage, not merely reachable through HEAD, so recovery
// still finds it once HEAD has moved off the line the import synced against.
test('the committed tree is anchored in the base lineage when an import runs over uncommitted source', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.commitSource(r, J, { 'a.json': 'S0' }, 'baseline source');
  const committed = h.git(r, 'rev-parse', `HEAD:${J}`);

  fs.writeFileSync(path.join(r, J, 'a.json'), 'DIRTY');
  h.runOp('postImport', r, J, lib);

  const meta = h.readMeta(r, J, lib);
  assert.notEqual(meta.baseTree, committed, 'the base is the imported (live) tree, not the committed one');

  const lineage = h.git(r, 'rev-list', '--format=%T', '--no-commit-header', h.baseRefTarget(r, J, lib)).split('\n');
  assert.ok(lineage.includes(meta.baseTree), 'the imported tree is in the lineage');
  assert.ok(lineage.includes(committed), 'the committed tree is anchored in the lineage too');
});

test('a clean import records the imported source tree as the base', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'S0' });
  const meta = h.readMeta(r, J, lib);
  const committed = h.git(r, 'rev-parse', `HEAD:${J}`);
  assert.equal(meta.baseTree, committed, 'nothing was uncommitted, so the imported tree is the committed one');
  const baseRefTree = h.git(r, 'rev-parse', `${h.baseRefTarget(r, J, lib)}^{tree}`);
  assert.equal(baseRefTree, committed, 'the base lineage ref points at the imported source tree');
});
