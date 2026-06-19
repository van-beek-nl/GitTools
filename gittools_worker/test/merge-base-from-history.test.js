// Recovering the merge base from HEAD's history. When the live source is no longer
// GitTools' last output (a pull, discard, or partial commit moved it), the recorded base is
// unreliable, so the base is recomputed as the true common ancestor by walking HEAD's
// subtree history. These guard that walk: if it truncated, misordered, or dropped its oldest
// entry, the deep ancestor would be missed and the base would collapse to none, turning the
// three-way merge into a blind overwrite and flipping both outcomes.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

const DEPTH = 12; // the recorded base sits this many commits back

test('a conflict is detected against a base recorded many commits back in history', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' }); // recorded base = {a0,b0}
  for (let i = 1; i <= DEPTH; i++) {                          // colleague advances a; b untouched
    h.commitSource(r, J, { 'a.json': `a${i}`, 'b.json': 'b0' }, `colleague ${i}`, { clear: true });
  }
  // The library changed a differently. Found against the true base {a0,b0} (DEPTH back), the
  // three-way merge sees both edits to a and conflicts.
  const res = h.exportLib(r, J, lib, { 'a.json': 'aMINE', 'b.json': 'b0' });
  assert.equal(res, 'conflict', 'the deep base is found, so both edits to a collide');
});

test('a clean merge preserves a colleague change made many commits back in history', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'a.json': 'a0', 'b.json': 'b0' }); // recorded base = {a0,b0}
  for (let i = 1; i <= DEPTH; i++) {                          // colleague advances b; a untouched
    h.commitSource(r, J, { 'a.json': 'a0', 'b.json': `b${i}` }, `colleague ${i}`, { clear: true });
  }
  // The library changed only a. Disjoint edits merge cleanly against the deep base, keeping
  // the colleague's latest b. Had the base collapsed to none, b would be overwritten to b0.
  const res = h.exportLib(r, J, lib, { 'a.json': 'aMINE', 'b.json': 'b0' });
  const f = h.readSrc(r, J);
  assert.equal(res, 'clean', 'disjoint edits merge cleanly against the deep base');
  assert.equal(f['a.json'], 'aMINE', 'the library change to a is applied');
  assert.equal(f['b.json'], `b${DEPTH}`, "the colleague's deep change to b is preserved");
});
