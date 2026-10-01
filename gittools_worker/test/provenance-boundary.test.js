// Without a base lineage, the per-file base falls back to the last export: only the library's diff
// since then lands, and content HEAD has since moved away from is not re-asserted over the commit.

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('../test-support/helpers');
const { J } = h;
const L = (...a) => a.join('\n') + '\n';

test('unknown provenance still lets genuinely new library work export', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 't.json': L('L1','L2','L3') });
  h.exportLib(r, J, lib, { 't.json': L('L1','L2','L3','MARK') });
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'baseline');   // HEAD: ...,MARK
  h.exportLib(r, J, lib, { 't.json': L('L1','L2','L3','MARK','#TEST') }); // exported, NOT committed
  h.git(r, 'update-ref', '-d', `refs/gittools/${h.stateKey(r,J,lib)}/base`);  // wipe provenance
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);                // drift
  // library now carries BRAND NEW work (L1 -> L1-new) alongside the uncommitted #TEST
  const res = h.exportLib(r, J, lib, { 't.json': L('L1-new','L2','L3','MARK','#TEST') });
  const f = h.read1(r, J, 't.json');
  assert.equal(res, 'clean', 'no conflict: the new work does not collide with HEAD');
  assert.equal(f.includes('L1-new'), true, 'work done since the last export still lands');
  assert.equal(f.includes('#TEST'), false, 'already-exported content is not re-asserted over the commit');
});
