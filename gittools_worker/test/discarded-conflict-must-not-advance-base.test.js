// Regression: a DISCARDED export conflict must never be recorded as an ACCEPTED one.
//
// From a field report (omnis_20260728.log, 12:04 -> 12:07). resolvePendingConflict discards
// uncommitted work by restoring the JSON path to HEAD, then decides "did the user accept the
// export?" by replaying the conflicting three-way merge. When the discard lands the source
// exactly on pending.baseTree, that replay degenerates: a merge whose base equals one side can
// never conflict, it just returns the other side. GitTools read that guaranteed-clean exit as
// proof of acceptance and advanced the base to the export tree.
//
// Advancing the base there is unrecoverable: from then on base == exportTree, so every later
// merge is (base=X, ours=HEAD, theirs=X), which resolves to `ours` and writes nothing. The
// library's content can never reach git again. In the field this showed up as "no more changed
// files from the codebase" and exports that silently did nothing.
//
// The state that triggers it (base == HEAD's tree while source != base) is not exotic: it is
// exactly what postImport records when an import runs over uncommitted source, which is the
// normal case (Omnis can only import a whole library at once).

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

test('a conflict that was discarded (not resolved) must not advance the base past the library', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  // Commit a source, then leave an uncommitted edit in the JSON path and import over it.
  // postImport records baseTree = HEAD's tree, sourceTree = the live tree -> base != source,
  // and crucially base == HEAD's tree.
  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'b0' }, 'initial source');
  h.writeFiles(`${r}/${J}`, { 'a.json': 'aLIVE' });
  h.runOp('postImport', r, J, lib);

  const meta = h.readMeta(r, J, lib);
  assert.equal(meta.baseTree, h.git(r, 'rev-parse', `HEAD:${J}`), 'precondition: base == HEAD tree');
  assert.notEqual(meta.sourceTree, meta.baseTree, 'precondition: source has uncommitted work');

  // Export a library that edits the same file -> modify/modify conflict against the live edit.
  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'b0' }), 'conflict',
    'export conflicts with the uncommitted live edit');

  // The user discards the conflict in their Git client, landing the source on HEAD --
  // which here is exactly pending.baseTree, making the acceptance replay degenerate.
  h.git(r, 'restore', '--source=HEAD', '--staged', '--worktree', '--', J);
  h.git(r, 'clean', '-fdq', '--', J);

  // Re-export the SAME library.
  h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'b0' });

  // The discard threw away the live edit, so the library is the only surviving authority for
  // a.json: its content must be on disk. Before the fix this was 'a0' -- the base had been
  // advanced to the export tree, so the merge resolved to HEAD and wrote nothing.
  assert.equal(h.read1(r, J, 'a.json'), 'aX', "the library's content reaches the working tree");

  // And it must not be a one-off: with the base wrongly advanced, the loss was permanent.
  h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'b0' });
  assert.equal(h.read1(r, J, 'a.json'), 'aX', 'still present after a further export');
});

test('a genuinely resolved conflict is still recognised and still advances the base', () => {
  const r = h.newRepo(); const lib = h.libOf(r);

  h.commitSource(r, J, { 'a.json': 'a0', 'b.json': 'b0' }, 'initial source');
  h.writeFiles(`${r}/${J}`, { 'a.json': 'aLIVE' });
  h.runOp('postImport', r, J, lib);

  assert.equal(h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'b0' }), 'conflict',
    'export conflicts with the uncommitted live edit');

  // Resolve by hand in favour of the export, exactly as the conflict message instructs,
  // and leave the resolution uncommitted (GitTools' own model surfaces exports as unstaged
  // working-tree edits the user reviews and stages deliberately).
  h.writeFiles(`${r}/${J}`, { 'a.json': 'aX' });
  h.git(r, 'add', '-A');

  const res = h.exportLib(r, J, lib, { 'a.json': 'aX', 'b.json': 'b0' });
  assert.equal(res, 'clean', 'the accepted export does not re-conflict');
  assert.equal(h.read1(r, J, 'a.json'), 'aX', 'the resolution is preserved');
});
