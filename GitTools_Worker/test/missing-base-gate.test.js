// The missing-base safety gate. With no reconciliation base, applying an export would
// blindly overwrite committed work, so pre-export refuses (result 'missing-base');
// post-export refuses too as a backstop; allowMissingBase is the explicit acknowledgement
// that forces the overwrite. A genuine first export (nothing committed to lose) is not gated.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../test-support/helpers');
const { J } = h;

test('pre-export refuses to overwrite committed source with no base, then allowMissingBase forces it', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.commitSource(r, J, { 'a.json': 'a0' }, 'committed source, never imported/exported -> no base');
  h.omnisExport(r, J, lib, { 'a.json': 'a1' });
  assert.equal(h.runOp('pre-export', r, J, lib), 'missing-base', 'pre-export gates');
  assert.ok(!fs.existsSync(h.handoffPath(r, J, lib)), 'no handoff is written, so the export cannot proceed');
  assert.equal(h.read1(r, J, 'a.json'), 'a0', 'the committed source is untouched by the gated run');
  // Re-run with the acknowledgement.
  assert.equal(h.runOp('pre-export', r, J, lib, { allowMissingBase: true }), undefined, 'forced pre-export bypasses the gate');
  assert.ok(fs.existsSync(h.handoffPath(r, J, lib)), 'forced pre-export writes the handoff');
  assert.equal(h.runOp('post-export', r, J, lib, { allowMissingBase: true }), 'clean', 'forced post-export applies');
  assert.equal(h.read1(r, J, 'a.json'), 'a1', 'the overwrite is applied');
});

test('post-export refuses to apply a baseless overwrite that was not acknowledged', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.commitSource(r, J, { 'a.json': 'a0' }, 'committed source, no base');
  h.omnisExport(r, J, lib, { 'a.json': 'a1' });
  // Simulate the pre-export signal being bypassed: force pre (writes the handoff), then run
  // post WITHOUT the flag. The backstop must refuse rather than silently overwrite.
  h.runOp('pre-export', r, J, lib, { allowMissingBase: true });
  assert.equal(h.runOp('post-export', r, J, lib), 'missing-base', 'the post-export backstop gates');
  assert.equal(h.read1(r, J, 'a.json'), 'a0', 'the committed source is not overwritten');
  assert.ok(!fs.existsSync(h.handoffPath(r, J, lib)), 'the handoff is cleared for a clean retry');
});

test('an export finds no base anywhere in history and gates rather than overwriting', () => {
  // A repo that never imported/exported here has an empty base lineage; the history walk
  // finds nothing, so the export must gate rather than hunt forever or overwrite blindly.
  const r = h.newRepo(); const lib = h.libOf(r);
  h.commitSource(r, J, { 'a.json': 'z0' }, 'source only, no gittools state');
  h.omnisExport(r, J, lib, { 'a.json': 'z1' });
  assert.equal(h.runOp('pre-export', r, J, lib), 'missing-base', 'no base found anywhere -> gate');
});

test('a first export of a path absent from HEAD proceeds without gating', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  fs.writeFileSync(path.join(r, 'README.md'), 'hello');
  h.git(r, 'add', 'README.md'); h.git(r, 'commit', '-q', '-m', 'unrelated commit; the json path is not in HEAD');
  h.omnisExport(r, J, lib, { 'a.json': 'a0' });
  assert.equal(h.runOp('pre-export', r, J, lib), undefined, 'no committed source to lose, so no gate');
  assert.equal(h.runOp('post-export', r, J, lib), 'clean', 'the first export applies');
  assert.equal(h.read1(r, J, 'a.json'), 'a0', 'its content lands');
});
