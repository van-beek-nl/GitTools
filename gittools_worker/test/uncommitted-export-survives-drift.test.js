// Regression: a library change that was exported but not yet committed must survive the next
// export, instead of being reverted to HEAD.
//
// From the field report (bug_description.txt, 2026-07-30): a '#TEST!' comment was exported, left
// uncommitted, and then silently erased from the working tree by a later export while it was still
// sitting in the Omnis library. Verified against the colleague's repo: the recorded base tree
// 8ddfbd94 already contained the comment.
//
// Mechanism: buildReconciliationBase gives files that a commit touched since the sync their value
// from metaObject.baseTree -- the LAST EXPORT. An export is only a proposal until it is committed,
// so for a change that was exported and not committed the base already holds it. The merge then
// reads base == theirs as "the library changed nothing here" and keeps `ours` (HEAD), deleting it.
//
// The discriminator is provenance: has the library ever PRODUCED what HEAD holds for this file?
//   - yes -> the library has already moved past it, so the library's content wins
//   - no  -> it arrived from git and was never imported (a peer's work), so it must be protected
// The base lineage ref records every tree the library ever produced, which answers exactly that.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

test('an exported-but-uncommitted library change is not reverted to HEAD by the next export', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  // Baseline import: records the sync commit and the first lineage entry.
  h.importLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v0' });

  // The developer does a round of work the normal way: export, review, commit. HEAD's t.json is
  // now content the library itself produced, so it is in the lineage.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1' }), 'clean');
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'commit exported v1');

  // They keep working and export a small follow-up tweak, but do not commit it yet.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1+TEST' }), 'clean');
  assert.equal(h.read1(r, J, 't.json'), 'v1+TEST', 'the tweak reached the working tree');

  // Anything that moves the working tree off GitTools' last output puts the next export on the
  // drift path -- here a discard, but a pull or a checkout does the same.
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);

  // Export again. The library still holds the tweak, so the working tree must show it. Before the
  // fix this silently reverted to 'v1': the base already contained '+TEST', so the merge concluded
  // the library had changed nothing and kept HEAD.
  const res = h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1+TEST' });
  assert.equal(res, 'clean', 'reconciles cleanly');
  assert.equal(h.read1(r, J, 't.json'), 'v1+TEST', "the library's uncommitted tweak survives the export");
});

test('a peer commit is still protected when the library never produced HEAD\'s content', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  h.importLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v0' });

  // The developer exports a change to t and leaves it uncommitted.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1' }), 'clean');

  // They set it aside, then a teammate's independent change to the same file lands on HEAD.
  // 'peer' is content the library has never produced, so it must not be overwritten.
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);
  h.commitSource(r, J, { 'a.json': 'a0', 't.json': 'peer' }, 'teammate edits t');

  h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1' });
  assert.equal(h.read1(r, J, 't.json'), 'peer', "the teammate's committed change is not dropped");
});

test('an unavailable base lineage degrades to protecting committed content, not to overwriting it', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  // The lineage lives in .git and is never pushed, so a fresh clone (or a pruned ref) has none.
  // With no provenance record, nothing can be shown to have come from the library, and every
  // file must fall back to the recorded base -- the pre-provenance behaviour. The one thing that
  // must never happen is the reverse: treating "unknown provenance" as "the library owns it".
  h.importLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v0' });
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1' }), 'clean');
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'commit exported v1');
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1+TEST' }), 'clean');
  h.git(r, 'restore', '--source=HEAD', '--worktree', '--', J);

  h.git(r, 'update-ref', '-d', `refs/gittools/${h.stateKey(r, J, lib)}/base`);
  assert.equal(h.baseRefTarget(r, J, lib), '', 'the lineage is gone');

  const res = h.exportLib(r, J, lib, { 'a.json': 'a0', 't.json': 'v1+TEST' });
  assert.equal(res, 'clean', 'a missing lineage is not an error');
  assert.equal(h.read1(r, J, 't.json'), 'v1', 'falls back to HEAD rather than overwriting it blindly');
});
