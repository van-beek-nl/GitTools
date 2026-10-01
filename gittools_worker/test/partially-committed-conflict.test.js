// Acceptance: an export conflict the developer only partly commits must not leave later exports
// merging against the last import. Before per-file bases, every such export fell back to that
// stale base: the developer's own committed work re-conflicted, and undoing it was silently lost.

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../test-support/helpers');
const { J } = h;

const PO = 'oorOrderRecordTasks/$CheckPurchaseOrderContent.omh';
const ENV = 'PionUsEnvironment/class.json';

function env(userinfo) {
  return `{\n\t"classtype": "kTask",\n\t"userinfo": "${userinfo}",\n\t"version": "11"\n}\n`;
}

// Export conflicts on ENV; the developer commits only `committed` and discards the rest.
function exportAndCommitOnly(r, lib, files, committed) {
  assert.equal(h.exportLib(r, J, lib, files), 'conflict', 'precondition: the export conflicts on ENV');
  h.git(r, 'checkout', 'HEAD', '--', `${J}/${ENV}`);
  h.git(r, 'add', '--', ...committed.map((f) => `${J}/${f}`));
  h.git(r, 'commit', '-q', '-m', 'commit only my changes');
}

// gittools-bugreport-20261001: a peer fix on top of the developer's own committed version.
test('a peer edit on top of the developer\'s partly committed work does not re-conflict', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { [PO]: 'If a\n\tDo x\nEnd If\n', [ENV]: env('2026-09-02') });
  h.commitSource(r, J, { [PO]: 'If a\n\tDo x\nEnd If\n', [ENV]: env('2026-09-23') }, 'peer touches ENV');

  const library = { [PO]: 'If a\n\tDo y\nEnd If\n', [ENV]: env('2026-10-01') };
  exportAndCommitOnly(r, lib, library, [PO]);
  h.commitSource(r, J, { [PO]: 'If a\n\tDo w\nEnd If\n', [ENV]: env('2026-09-23') }, 'Mr. Robot rewrites the line');

  assert.equal(h.exportLib(r, J, lib, library), 'conflict', 'ENV still genuinely conflicts');
  assert.equal(h.stat(r, `${J}/${ENV}`), 'UU');
  assert.equal(h.stat(r, `${J}/${PO}`), '  ', 'PO is not conflicted');
  assert.equal(h.read1(r, J, PO), 'If a\n\tDo w\nEnd If\n', "the peer's fix is kept");
});

test('undoing a partly committed change in the library reaches git', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': 'a\nb\n', [ENV]: env('0') });
  h.commitSource(r, J, { 'f.json': 'a\nb\n', [ENV]: env('peer') }, 'peer touches ENV');
  exportAndCommitOnly(r, lib, { 'f.json': 'a\nb\nX\n', [ENV]: env('lib') }, ['f.json']);

  h.exportLib(r, J, lib, { 'f.json': 'a\nb\n', [ENV]: env('lib') });
  assert.equal(h.read1(r, J, 'f.json'), 'a\nb\n');
});

test('a peer removing partly committed work does not get it resurrected', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': 'a\nb\nc\n', [ENV]: env('0') });
  h.commitSource(r, J, { 'f.json': 'a\nb\nc\n', [ENV]: env('peer') }, 'peer touches ENV');
  const library = { 'f.json': 'a\nb\nc\nX\n', [ENV]: env('lib') };
  exportAndCommitOnly(r, lib, library, ['f.json']);
  h.commitSource(r, J, { 'f.json': 'A\nb\nc\n', [ENV]: env('peer') }, 'peer edits a and drops X');

  h.exportLib(r, J, lib, library);
  assert.equal(h.read1(r, J, 'f.json'), 'A\nb\nc\n');
});

test('deleting a partly committed new file in the library reaches git', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { [ENV]: env('0') });
  h.commitSource(r, J, { [ENV]: env('peer') }, 'peer touches ENV');
  exportAndCommitOnly(r, lib, { 'new.json': 'n', [ENV]: env('lib') }, ['new.json']);

  h.exportLib(r, J, lib, { [ENV]: env('lib') });
  assert.equal(h.read1(r, J, 'new.json'), '<missing>');
});

test('the uncommitted remainder of a partly committed export still resurfaces', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  h.importLib(r, J, lib, { 'f.json': 'f0', 'g.json': 'g0', [ENV]: env('0') });
  h.commitSource(r, J, { 'f.json': 'f0', 'g.json': 'g0', [ENV]: env('peer') }, 'peer touches ENV');
  const library = { 'f.json': 'f1', 'g.json': 'g1', [ENV]: env('lib') };
  exportAndCommitOnly(r, lib, library, ['f.json']);
  h.git(r, 'checkout', 'HEAD', '--', J);

  h.exportLib(r, J, lib, library);
  assert.equal(h.read1(r, J, 'g.json'), 'g1', 'the uncommitted library change is not dropped');
  assert.equal(h.stat(r, `${J}/f.json`), '  ', 'the committed file is not touched');
});

// A cleanly merged export is committed as a mix nobody's library ever held; it must still count
// as the developer's last sync for that file.
test('a committed clean merge of an export is recognised when a peer later edits the same line', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const L = (...a) => a.join('\n') + '\n';
  h.importLib(r, J, lib, { 'f.json': L('L1', 'L2', 'L3', 'L4', 'L5') });
  h.commitSource(r, J, { 'f.json': L('L1-peer', 'L2', 'L3', 'L4', 'L5') }, 'peer edits line 1');
  const library = { 'f.json': L('L1', 'L2', 'L3', 'L4-dev', 'L5') };
  assert.equal(h.exportLib(r, J, lib, library), 'clean');
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'commit merged export');
  h.commitSource(r, J, { 'f.json': L('L1-peer', 'L2', 'L3', 'L4-peer', 'L5') }, 'peer replaces line 4');

  assert.equal(h.exportLib(r, J, lib, library), 'clean');
  assert.equal(h.read1(r, J, 'f.json'), L('L1-peer', 'L2', 'L3', 'L4-peer', 'L5'));
});

test('a peer undoing a committed clean merge of an export is respected', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const L = (...a) => a.join('\n') + '\n';
  h.importLib(r, J, lib, { 'f.json': L('L1', 'L2', 'L3', 'L4', 'L5') });
  h.commitSource(r, J, { 'f.json': L('L1-peer', 'L2', 'L3', 'L4', 'L5') }, 'peer edits line 1');
  const library = { 'f.json': L('L1', 'L2', 'L3', 'L4-dev', 'L5') };
  assert.equal(h.exportLib(r, J, lib, library), 'clean');
  h.git(r, 'add', '-A'); h.git(r, 'commit', '-q', '-m', 'commit merged export');
  h.commitSource(r, J, { 'f.json': L('L1-peer', 'L2', 'L3', 'L4', 'L5') }, 'peer reverts line 4');

  assert.equal(h.exportLib(r, J, lib, library), 'clean');
  assert.equal(h.read1(r, J, 'f.json'), L('L1-peer', 'L2', 'L3', 'L4', 'L5'));
});

test('an export change left out of a partial commit still reaches git', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const L = (...a) => a.join('\n') + '\n';
  h.importLib(r, J, lib, { 'f.json': L('L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7') });
  h.commitSource(r, J, { 'f.json': L('L1-peer', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7') }, 'peer edits line 1');
  const library = { 'f.json': L('L1', 'L2', 'L3', 'L4-dev', 'L5', 'L6', 'L7-dev') };
  assert.equal(h.exportLib(r, J, lib, library), 'clean');

  // Commit only the line 4 hunk of the merged output.
  h.commitSource(r, J, { 'f.json': L('L1-peer', 'L2', 'L3', 'L4-dev', 'L5', 'L6', 'L7') }, 'commit one hunk');
  h.commitSource(r, J, { 'f.json': L('L1-peer2', 'L2', 'L3', 'L4-dev', 'L5', 'L6', 'L7') }, 'peer edits line 1 again');

  assert.equal(h.exportLib(r, J, lib, library), 'clean');
  assert.equal(h.read1(r, J, 'f.json'), L('L1-peer2', 'L2', 'L3', 'L4-dev', 'L5', 'L6', 'L7-dev'));
});

// Lineages written before conflicted exports were recorded can lack the export that introduced a
// file; its earlier name must still give the merge a base.
test('a renamed file with no recorded output under its new name merges through its old name', () => {
  const r = h.newRepo(); const lib = h.libOf(r);
  const L = (...a) => a.join('\n') + '\n';
  const body = Array.from({ length: 20 }, (_, i) => `Do method line${i}`);
  const c0 = L('Begin', ...body, 'End');
  const c1 = L('Begin-dev', ...body, 'End');
  const c2 = L('Begin-dev', ...body, 'End-dev');
  h.importLib(r, J, lib, { 'old.omh': c0, [ENV]: env('0') });
  h.commitSource(r, J, { 'old.omh': c0, [ENV]: env('peer') }, 'peer touches ENV');
  exportAndCommitOnly(r, lib, { 'new.omh': c1, [ENV]: env('lib') }, ['new.omh', 'old.omh']);

  // Drop the conflicted export from the lineage, as an older GitTools would never have recorded it.
  const ref = `refs/gittools/${h.stateKey(r, J, lib)}/base`;
  h.git(r, 'update-ref', ref, `${ref}~1`);

  h.exportLib(r, J, lib, { 'new.omh': c2, [ENV]: env('lib') });
  assert.equal(h.stat(r, `${J}/new.omh`), ' M', 'merged, not an add/add conflict');
  assert.equal(h.read1(r, J, 'new.omh'), c2);
});
